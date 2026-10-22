/* llm.c - Llama-style decoder forward pass micro-benchmark with RANDOM weights.
 *
 * RMSNorm, RoPE, GQA multi-head attention with an f32 KV cache, SwiGLU MLP,
 * tied embedding / LM head.  Weight formats:
 *   f32   : f32 compute, f16 download (reference)
 *   q8    : int8 weights, per-row scale;      int8 activations (per-token scale)
 *   q4g32 : 4-bit nibbles, f16 scale per 32;  int8 activations
 *   q4g64 : 4-bit nibbles, f16 scale per 64;  int8 activations
 *   q4f   : same storage as q4g32 but f32 activations (to show why int8 acts win)
 *   t2    : ternary {-1,0,1} packed 2 bits, per-row scale (BitNet-b1.58 style);
 *           int8 activations; the tied embedding / LM head stays q8.
 * Kernels: wasm SIMD128 (i32x4.dot_i16x8_s), wasm relaxed-simd
 * (i32x4.relaxed_dot_i8x16_i7x16_add_s), native x86 128-bit (pmaddwd / vpdpbusd),
 * plus a plain-C reference kernel (FORCE_SCALAR build or --ref).
 *
 * Build: see build.sh.  Run: llm test | llm bench <cfg> <fmt> | llm kern <cfg> <fmt>
 */
#define _GNU_SOURCE
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "simd.h"

#define AI static inline __attribute__((always_inline))
#define UR _Pragma("clang loop unroll(full)")
#define FOR_R for (int i = 0; i < R; i++)
#define FOR_T for (int j = 0; j < NT; j++)
#define MAXR 4
#define MAXT 4

#define HD 64          /* head dim (all configs) */
#ifndef MAXCTX
#define MAXCTX 1152    /* KV cache capacity, multiple of 16 (-DMAXCTX=2112 for 2K-context models) */
#endif
#ifndef TMAX
#define TMAX 1024      /* max tokens per forward() call */
#endif
#define MAXTH 64

#if defined(__wasm__)
#define TARGET "wasm32"
#else
#define TARGET "native"
#endif

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1e3 + ts.tv_nsec * 1e-6;
}
static void *xalloc(size_t n) {
  void *p = aligned_alloc(64, (n + 63) & ~(size_t)63);
  if (!p) { fprintf(stderr, "OOM (%zu bytes)\n", n); exit(1); }
  return p;
}
static void *xcalloc(size_t n) { void *p = xalloc(n); memset(p, 0, n); return p; }
static size_t al16(size_t x) { return (x + 15) & ~(size_t)15; }

/* ---------------- RNG / f16 ---------------- */
static uint64_t rng_s = 88172645463325252ull;
static inline uint64_t rng(void) { rng_s ^= rng_s << 13; rng_s ^= rng_s >> 7; rng_s ^= rng_s << 17; return rng_s; }
static inline float rngf(void) { return (float)(rng() >> 40) * (1.0f / 16777216.0f); }
static uint16_t f32_to_f16(float f) {
  uint32_t x; memcpy(&x, &f, 4);
  uint32_t sign = (x >> 16) & 0x8000, m = x & 0x7fffff;
  int32_t e = (int32_t)((x >> 23) & 0xff) - 127 + 15;
  if (e <= 0) return (uint16_t)sign;
  if (e >= 31) return (uint16_t)(sign | 0x7c00);
  uint32_t h = sign | ((uint32_t)e << 10) | (m >> 13);
  if (m & 0x1000) h++;
  return (uint16_t)h;
}
static inline float f16_to_f32(uint16_t h) { /* branch-free; finite inputs */
  uint32_t x = (uint32_t)(h & 0x7fff) << 13; float f; memcpy(&f, &x, 4);
  f *= 0x1p112f; memcpy(&x, &f, 4); x |= (uint32_t)(h & 0x8000) << 16; memcpy(&f, &x, 4);
  return f;
}

/* ---------------- configs / formats ---------------- */
typedef struct { const char *name; int V, d, L, nh, nkv, ffn; } Cfg;
static const Cfg CFGS[] = {
  {"A", 16384, 384, 8, 6, 2, 1024},
  {"B", 16384, 512, 10, 8, 2, 1408},
  {"C", 16384, 640, 12, 10, 2, 1728},
  {"D", 49152, 576, 30, 9, 3, 1536},
  {"tiny", 1024, 128, 2, 2, 1, 256},
};
enum { F_F32, F_Q8, F_Q4, F_Q4F, F_T2 };
typedef struct { const char *name; int bfmt, bgs, hfmt, hgs; } Spec;
static const Spec SPECS[] = {
  {"f32", F_F32, 0, F_F32, 0},
  {"q8", F_Q8, 0, F_Q8, 0},
  {"q4g32", F_Q4, 32, F_Q4, 32},
  {"q4g64", F_Q4, 64, F_Q4, 64},
  {"q4f", F_Q4F, 32, F_Q4F, 32},
  {"t2", F_T2, 0, F_Q8, 0},
};

typedef struct {
  int fmt, rows, cols, gs;
  const uint8_t *q; /* packed weights (points into the loaded blob) */
  float *s;         /* scales: per row (q8,t2) or per row x group (q4) */
  float *f;         /* f32 weights (F_F32) */
} QMat;

static size_t mat_qbytes(int fmt, int rows, int cols) {
  size_t n = (size_t)rows * cols;
  switch (fmt) {
  case F_F32: return n * 2; /* f16 in the download */
  case F_Q8: return n;
  case F_Q4: case F_Q4F: return n / 2;
  case F_T2: return n / 4;
  }
  return 0;
}
static size_t mat_nscales(int fmt, int rows, int cols, int gs) {
  switch (fmt) {
  case F_Q8: case F_T2: return rows;
  case F_Q4: case F_Q4F: return (size_t)rows * (cols / gs);
  }
  return 0;
}

/* ---------------- thread pool (native only) ---------------- */
typedef void (*task_fn)(void *ctx, int tid, int nth);
static int g_nth = 1;
#ifdef USE_THREADS
#include <pthread.h>
#include <stdatomic.h>
static task_fn g_task;
static void *g_tctx;
static atomic_int g_gen, g_done;
static pthread_t g_thr[MAXTH];
static void *worker(void *arg) {
  int tid = (int)(intptr_t)arg, seen = 0;
  for (;;) {
    int g;
    while ((g = atomic_load_explicit(&g_gen, memory_order_acquire)) == seen) __builtin_ia32_pause();
    seen = g;
    g_task(g_tctx, tid, g_nth);
    atomic_fetch_add_explicit(&g_done, 1, memory_order_acq_rel);
  }
  return NULL;
}
static void pool_start(int n) {
  if (n > MAXTH) n = MAXTH;
  g_nth = n;
  for (int i = 1; i < n; i++) pthread_create(&g_thr[i], NULL, worker, (void *)(intptr_t)i);
}
static void parallel(task_fn f, void *ctx) {
  if (g_nth == 1) { f(ctx, 0, 1); return; }
  g_task = f; g_tctx = ctx;
  atomic_store_explicit(&g_done, 0, memory_order_relaxed);
  atomic_fetch_add_explicit(&g_gen, 1, memory_order_acq_rel);
  f(ctx, 0, g_nth);
  while (atomic_load_explicit(&g_done, memory_order_acquire) != g_nth - 1) __builtin_ia32_pause();
}
#elif defined(WASM_THREADS)
/* wasm threads without pthreads: the JS host instantiates the same module in N-1 extra Workers on the
 * same shared memory, sets each one's __stack_pointer to worker_stack(tid) and calls worker_entry(tid). */
#include <stdatomic.h>
#define WT_MAX 16
#define WT_STACK (256 * 1024)
static task_fn g_task;
static void *g_tctx;
static atomic_int g_gen, g_done;
static unsigned char g_wstack[WT_MAX][WT_STACK] __attribute__((aligned(16)));
__attribute__((export_name("worker_stack"))) uintptr_t worker_stack(int tid) { return (uintptr_t)&g_wstack[tid][WT_STACK]; }
/* A worker spins for the next task (they come back to back within a forward pass), then sleeps on a futex,
 * so an idle pool costs no CPU. */
#define WT_SPIN (1 << 18)
static atomic_int g_sleepers;
__attribute__((export_name("worker_entry"))) void worker_entry(int tid) {
  int seen = 0;
  for (;;) {
    int g, spin = 0;
    while ((g = atomic_load_explicit(&g_gen, memory_order_acquire)) == seen) {
      if (++spin < WT_SPIN) continue;
      atomic_fetch_add(&g_sleepers, 1);
      __builtin_wasm_memory_atomic_wait32((int *)&g_gen, seen, -1);
      atomic_fetch_sub(&g_sleepers, 1);
      spin = 0;
    }
    seen = g;
    g_task(g_tctx, tid, g_nth);
    atomic_fetch_add_explicit(&g_done, 1, memory_order_acq_rel);
  }
}
static void pool_start(int n) { g_nth = n < 1 ? 1 : n > WT_MAX ? WT_MAX : n; }
static void parallel(task_fn f, void *ctx) {
  if (g_nth == 1) { f(ctx, 0, 1); return; }
  g_task = f; g_tctx = ctx;
  atomic_store_explicit(&g_done, 0, memory_order_relaxed);
  atomic_fetch_add(&g_gen, 1);
  if (atomic_load(&g_sleepers)) __builtin_wasm_memory_atomic_notify((int *)&g_gen, WT_MAX);
  f(ctx, 0, g_nth);
  while (atomic_load_explicit(&g_done, memory_order_acquire) != g_nth - 1) {}
}
#else
static void pool_start(int n) { (void)n; }
static void parallel(task_fn f, void *ctx) { f(ctx, 0, 1); }
#endif

/* ---------------- activation quantization ---------------- */
typedef struct {
  int8_t *q8; int16_t *q16; float *s; int32_t *sum;
  int32_t *corr; /* [T][n/gs][4]: lane0 = -8 * sum_group(xq)  (q4 zero point) */
  float *corrf;  /* [T][n/32][4]: lane0 = -8 * sum_group(x)   (q4f zero point) */
} QX;

static int g_perm8 = 0; /* swap 16-byte chunks 1<->2 inside each 64-block (layout of the 256-bit kernel) */
static void quant_rows(const float *X, int T, int n, int gs, int want8, int want16, int wantcorr, QX *Q) {
  const int ng = n / gs;
  for (int t = 0; t < T; t++) {
    const float *x = X + (size_t)t * n;
    int8_t *q8 = Q->q8 + (size_t)t * n;
    int16_t *q16 = Q->q16 + (size_t)t * n;
    int32_t *corr = Q->corr + (size_t)t * ng * 4;
#if HAVE_SIMD
    VF m = vsplatf(0.f);
    for (int c = 0; c < n; c += 4) m = vmaxf(m, vabsf(vldf(x + c)));
    float amax = vhmaxf(m), s = amax > 0 ? amax / 127.f : 1.f;
    VF inv = vsplatf(1.f / s);
    VI ones = vset16(1), gacc = vzero(), tacc = vzero();
    for (int c = 0; c < n; c += 16) {
      VI i0 = vcvti(vroundf(vmulf(vldf(x + c), inv)));
      VI i1 = vcvti(vroundf(vmulf(vldf(x + c + 4), inv)));
      VI i2 = vcvti(vroundf(vmulf(vldf(x + c + 8), inv)));
      VI i3 = vcvti(vroundf(vmulf(vldf(x + c + 12), inv)));
      VI a = vpack32(i0, i1), b = vpack32(i2, i3);
      if (want16) { vst(q16 + c, a); vst(q16 + c + 8, b); }
      if (want8) {
        int ci = (c >> 4) & 3, dst = g_perm8 ? (c - ci * 16) + ((ci == 1) ? 32 : (ci == 2) ? 16 : ci * 16) : c;
        vst(q8 + dst, vpack16(a, b));
      }
      gacc = vadd32(gacc, vadd32(vdot16(a, ones), vdot16(b, ones)));
      if (((c + 16) & (gs - 1)) == 0) {
        if (wantcorr) {
          int32_t *cp = corr + (c / gs) * 4;
          cp[0] = -8 * vhsum32(gacc); cp[1] = cp[2] = cp[3] = 0;
        }
        tacc = vadd32(tacc, gacc);
        gacc = vzero();
      }
    }
    Q->s[t] = s;
    Q->sum[t] = vhsum32(tacc);
#else
    float amax = 0;
    for (int c = 0; c < n; c++) amax = fmaxf(amax, fabsf(x[c]));
    float s = amax > 0 ? amax / 127.f : 1.f, inv = 1.f / s;
    int32_t tot = 0;
    for (int g = 0; g < ng; g++) {
      int32_t gsum = 0;
      for (int c = g * gs; c < (g + 1) * gs; c++) {
        int v = (int)rintf(x[c] * inv);
        if (want8) q8[c] = (int8_t)v;
        if (want16) q16[c] = (int16_t)v;
        gsum += v;
      }
      if (wantcorr) { corr[g * 4] = -8 * gsum; corr[g * 4 + 1] = corr[g * 4 + 2] = corr[g * 4 + 3] = 0; }
      tot += gsum;
    }
    Q->s[t] = s;
    Q->sum[t] = tot;
#endif
  }
}
static void quant_corrf(const float *X, int T, int n, QX *Q) {
  const int ng = n / 32;
  for (int t = 0; t < T; t++)
    for (int g = 0; g < ng; g++) {
      const float *x = X + (size_t)t * n + g * 32;
      float s = 0;
      for (int c = 0; c < 32; c++) s += x[c];
      float *cp = Q->corrf + ((size_t)t * ng + g) * 4;
      cp[0] = -8.f * s; cp[1] = cp[2] = cp[3] = 0;
    }
}

/* ---------------- matmul kernels ----------------
 * Y[t][r] = sum_c W[r][c] * X[t][c]   for t < T, r0 <= r < r1
 * Each kernel = a register tile of R rows x NT tokens (compile-time after inlining)
 * plus a driver that uses an (MV_R x 1) tile for decode and (MM_R x MM_T) for prefill. */
typedef void (*kern_fn)(const QMat *W, const QX *X, const float *Xf, int T, float *Y, int r0, int r1);
/* register-tile shapes: MVR rows for decode (1 token); MMR rows x MMT tokens for prefill */
#ifndef F32_MVR
#define F32_MVR 4
#define F32_MMR 2
#define F32_MMT 4
#endif
#ifndef Q8_MVR
#define Q8_MVR 4
#define Q8_MMR 2
#define Q8_MMT 4
#endif
#ifndef Q4S_MVR
#define Q4S_MVR 4
#define Q4S_MMR 1
#define Q4S_MMT 4
#endif
#ifndef T2S_MVR
#define T2S_MVR 4
#define T2S_MMR 1
#define T2S_MMT 4
#endif
#ifndef Q4F_MVR
#define Q4F_MVR 2
#define Q4F_MMR 1
#define Q4F_MMT 4
#endif
#ifndef Q4R_MVR
#define Q4R_MVR 4
#define Q4R_MMR 2
#define Q4R_MMT 2
#endif
#ifndef T2R_MVR
#define T2R_MVR 4
#define T2R_MMR 2
#define T2R_MMT 4
#endif
#define TCH 128 /* token chunk (keeps the activation block in L2 while weights stream) */
#define DEF_DRIVER(NAME, CALL, MVR, MMR, MMT)                                                   \
  static void NAME(const QMat *W, const QX *X, const float *Xf, int T, float *Y, int r0, int r1) { \
    (void)X; (void)Xf;                                                                          \
    if (T == 1) {                                                                               \
      int r = r0;                                                                               \
      for (; r + MVR <= r1; r += MVR) CALL(r, 0, MVR, 1);                                       \
      for (; r < r1; r++) CALL(r, 0, 1, 1);                                                     \
      return;                                                                                   \
    }                                                                                           \
    for (int tc = 0; tc < T; tc += TCH) {                                                       \
      int te = tc + TCH < T ? tc + TCH : T, r = r0;                                             \
      for (; r + MMR <= r1; r += MMR) {                                                         \
        int t = tc;                                                                             \
        for (; t + MMT <= te; t += MMT) CALL(r, t, MMR, MMT);                                   \
        if (te - t >= 2) { CALL(r, t, MMR, 2); t += 2; }                                        \
        if (t < te) CALL(r, t, MMR, 1);                                                         \
      }                                                                                         \
      for (; r < r1; r++)                                                                       \
        for (int t = tc; t < te; t++) CALL(r, t, 1, 1);                                         \
    }                                                                                           \
  }

/* plain C reference (also the FORCE_SCALAR build's kernel) */
static inline int nib4(const uint8_t *row, int c) {
  int b = row[(c >> 5) * 16 + (c & 15)];
  return (c & 16) ? (b >> 4) : (b & 15);
}
static inline int t2v(const uint8_t *row, int c) {
  int b = row[(c >> 6) * 16 + (c & 15)];
  return (b >> (2 * ((c >> 4) & 3))) & 3;
}
static void k_ref(const QMat *W, const QX *X, const float *Xf, int T, float *Y, int r0, int r1) {
  const int n = W->cols;
  switch (W->fmt) {
  case F_F32:
    for (int t = 0; t < T; t++)
      for (int r = r0; r < r1; r++) {
        const float *w = W->f + (size_t)r * n, *x = Xf + (size_t)t * n;
        float a = 0;
        for (int c = 0; c < n; c++) a += w[c] * x[c];
        Y[(size_t)t * W->rows + r] = a;
      }
    break;
  case F_Q8:
    for (int t = 0; t < T; t++)
      for (int r = r0; r < r1; r++) {
        const int8_t *w = (const int8_t *)W->q + (size_t)r * n, *x = X->q8 + (size_t)t * n;
        int32_t a = 0;
        for (int c = 0; c < n; c++) a += w[c] * x[c];
        Y[(size_t)t * W->rows + r] = (float)a * W->s[r] * X->s[t];
      }
    break;
  case F_Q4:
  case F_Q4F: {
    const int gs = W->gs, ng = n / gs;
    for (int t = 0; t < T; t++)
      for (int r = r0; r < r1; r++) {
        const uint8_t *w = W->q + (size_t)r * n / 2;
        float a = 0;
        for (int g = 0; g < ng; g++) {
          if (W->fmt == F_Q4) {
            const int8_t *x = X->q8 + (size_t)t * n;
            int32_t s = 0;
            for (int c = g * gs; c < (g + 1) * gs; c++) s += (nib4(w, c) - 8) * x[c];
            a += (float)s * W->s[(size_t)r * ng + g];
          } else {
            const float *x = Xf + (size_t)t * n;
            float s = 0;
            for (int c = g * gs; c < (g + 1) * gs; c++) s += (float)(nib4(w, c) - 8) * x[c];
            a += s * W->s[(size_t)r * ng + g];
          }
        }
        Y[(size_t)t * W->rows + r] = W->fmt == F_Q4 ? a * X->s[t] : a;
      }
  } break;
  case F_T2:
    for (int t = 0; t < T; t++)
      for (int r = r0; r < r1; r++) {
        const uint8_t *w = W->q + (size_t)r * n / 4;
        const int8_t *x = X->q8 + (size_t)t * n;
        int32_t a = 0;
        for (int c = 0; c < n; c++) a += (t2v(w, c) - 1) * x[c];
        Y[(size_t)t * W->rows + r] = (float)a * W->s[r] * X->s[t];
      }
    break;
  }
}

#if HAVE_SIMD
/* ---- f32 x f32 ---- */
AI void f32_tile(const QMat *W, const float *Xf, int r, int t, const int R, const int NT, float *Y) {
  const int n = W->cols;
  VF acc[MAXR][MAXT];
  const float *w[MAXR], *x[MAXT];
  UR FOR_R w[i] = W->f + (size_t)(r + i) * n;
  UR FOR_T x[j] = Xf + (size_t)(t + j) * n;
  UR FOR_R { UR FOR_T acc[i][j] = vsplatf(0.f); }
  for (int c = 0; c < n; c += 4) {
    VF wv[MAXR];
    UR FOR_R wv[i] = vldf(w[i] + c);
    UR FOR_T {
      VF xv = vldf(x[j] + c);
      UR FOR_R acc[i][j] = vfma(wv[i], xv, acc[i][j]);
    }
  }
  UR FOR_R { UR FOR_T Y[(size_t)(t + j) * W->rows + r + i] = vhsumf(acc[i][j]); }
}
#define C_F32(r, t, R, NT) f32_tile(W, Xf, r, t, R, NT, Y)
DEF_DRIVER(k_f32, C_F32, F32_MVR, F32_MMR, F32_MMT)

/* ---- q8 weights x int8 acts via i16 dot (pmaddwd) ---- */
AI void q8_tile(const QMat *W, const QX *X, int r, int t, const int R, const int NT, float *Y) {
  const int n = W->cols;
  VI acc[MAXR][MAXT];
  const int8_t *w[MAXR];
  const int16_t *x[MAXT];
  UR FOR_R w[i] = (const int8_t *)W->q + (size_t)(r + i) * n;
  UR FOR_T x[j] = X->q16 + (size_t)(t + j) * n;
  UR FOR_R { UR FOR_T acc[i][j] = vzero(); }
  for (int c = 0; c < n; c += 16) {
    VI wl[MAXR], wh[MAXR];
    UR FOR_R { wl[i] = vld8_i16(w[i] + c); wh[i] = vld8_i16(w[i] + c + 8); }
    UR FOR_T {
      VI x0 = vld(x[j] + c), x1 = vld(x[j] + c + 8);
      UR FOR_R acc[i][j] = vadd32(acc[i][j], vadd32(vdot16(wl[i], x0), vdot16(wh[i], x1)));
    }
  }
  UR FOR_R {
    float ws = W->s[r + i];
    UR FOR_T Y[(size_t)(t + j) * W->rows + r + i] = (float)vhsum32(acc[i][j]) * ws * X->s[t + j];
  }
}
#define C_Q8(r, t, R, NT) q8_tile(W, X, r, t, R, NT, Y)
DEF_DRIVER(k_q8, C_Q8, Q8_MVR, Q8_MMR, Q8_MMT)

/* ---- q4 (nibbles, block of 32 = 16 bytes: byte j = q[j] | q[j+16]<<4) via i16 dot ---- */
AI void q4s_tile(const QMat *W, const QX *X, int r, int t, const int R, const int NT, const int BPG, float *Y) {
  const int n = W->cols, ng = n / (32 * BPG), nbr = n / 2;
  const VI m = vset16(0x000F);
  VF facc[MAXR][MAXT];
  const uint8_t *w[MAXR];
  const float *ws[MAXR];
  const int16_t *x[MAXT];
  const int32_t *xc[MAXT];
  UR FOR_R { w[i] = W->q + (size_t)(r + i) * nbr; ws[i] = W->s + (size_t)(r + i) * ng; }
  UR FOR_T { x[j] = X->q16 + (size_t)(t + j) * n; xc[j] = X->corr + (size_t)(t + j) * ng * 4; }
  UR FOR_R { UR FOR_T facc[i][j] = vsplatf(0.f); }
  for (int g = 0; g < ng; g++) {
    VI ia[MAXR][MAXT];
    UR FOR_T {
      VI c0 = vld(xc[j] + 4 * g);
      UR FOR_R ia[i][j] = c0;
    }
    UR for (int b = 0; b < BPG; b++) {
      const int off = (g * BPG + b) * 32;
      VI w0[MAXR], w1[MAXR], w2[MAXR], w3[MAXR];
      UR FOR_R {
        VI b0 = vld8_u16(w[i] + off / 2), b1 = vld8_u16(w[i] + off / 2 + 8);
        w0[i] = vand(b0, m); w2[i] = vsrl16(b0, 4);
        w1[i] = vand(b1, m); w3[i] = vsrl16(b1, 4);
      }
      UR FOR_T {
        const int16_t *xp = x[j] + off;
        VI x0 = vld(xp), x1 = vld(xp + 8), x2 = vld(xp + 16), x3 = vld(xp + 24);
        UR FOR_R ia[i][j] = vadd32(ia[i][j], vadd32(vadd32(vdot16(w0[i], x0), vdot16(w1[i], x1)),
                                                    vadd32(vdot16(w2[i], x2), vdot16(w3[i], x3))));
      }
    }
    UR FOR_R {
      VF sc = vsplatf_mem(ws[i] + g);
      UR FOR_T facc[i][j] = vfma(vcvtf(ia[i][j]), sc, facc[i][j]);
    }
  }
  UR FOR_R { UR FOR_T Y[(size_t)(t + j) * W->rows + r + i] = vhsumf(facc[i][j]) * X->s[t + j]; }
}
#define C_Q4S32(r, t, R, NT) q4s_tile(W, X, r, t, R, NT, 1, Y)
#define C_Q4S64(r, t, R, NT) q4s_tile(W, X, r, t, R, NT, 2, Y)
DEF_DRIVER(k_q4s32, C_Q4S32, Q4S_MVR, Q4S_MMR, Q4S_MMT)
DEF_DRIVER(k_q4s64, C_Q4S64, Q4S_MVR, Q4S_MMR, Q4S_MMT)

/* ---- ternary, 2-bit fields (block of 64 = 16 bytes: byte j = q[j] | q[j+16]<<2 | q[j+32]<<4 | q[j+48]<<6),
 *      value q in {0,1,2} = w+1; correction -sum(x) per token ---- */
AI void t2s_tile(const QMat *W, const QX *X, int r, int t, const int R, const int NT, float *Y) {
  const int n = W->cols, nbr = n / 4;
  const VI m3 = vset16(3);
  VI acc[MAXR][MAXT];
  const uint8_t *w[MAXR];
  const int16_t *x[MAXT];
  UR FOR_R w[i] = W->q + (size_t)(r + i) * nbr;
  UR FOR_T x[j] = X->q16 + (size_t)(t + j) * n;
  UR FOR_R { UR FOR_T acc[i][j] = vzero(); }
  for (int c = 0; c < n; c += 64) {
    UR for (int h = 0; h < 2; h++) {
      VI f0[MAXR], f1[MAXR], f2[MAXR], f3[MAXR];
      UR FOR_R {
        VI b = vld8_u16(w[i] + c / 4 + 8 * h);
        f0[i] = vand(b, m3); f1[i] = vand(vsrl16(b, 2), m3);
        f2[i] = vand(vsrl16(b, 4), m3); f3[i] = vsrl16(b, 6);
      }
      UR FOR_T {
        const int16_t *xp = x[j] + c + 8 * h;
        VI x0 = vld(xp), x1 = vld(xp + 16), x2 = vld(xp + 32), x3 = vld(xp + 48);
        UR FOR_R acc[i][j] = vadd32(acc[i][j], vadd32(vadd32(vdot16(f0[i], x0), vdot16(f1[i], x1)),
                                                      vadd32(vdot16(f2[i], x2), vdot16(f3[i], x3))));
      }
    }
  }
  UR FOR_R {
    float ws = W->s[r + i];
    UR FOR_T Y[(size_t)(t + j) * W->rows + r + i] =
        (float)(vhsum32(acc[i][j]) - X->sum[t + j]) * ws * X->s[t + j];
  }
}
#define C_T2S(r, t, R, NT) t2s_tile(W, X, r, t, R, NT, Y)
DEF_DRIVER(k_t2s, C_T2S, T2S_MVR, T2S_MMR, T2S_MMT)

/* ---- q4 weights with f32 activations: dequantize nibbles to f32 in registers ---- */
AI void q4f_tile(const QMat *W, const QX *X, const float *Xf, int r, int t, const int R, const int NT, float *Y) {
  const int n = W->cols, ng = n / 32, nbr = n / 2;
  const VI m0f = vset8(0x0F);
  VF facc[MAXR][MAXT];
  const uint8_t *w[MAXR];
  const float *ws[MAXR];
  UR FOR_R { w[i] = W->q + (size_t)(r + i) * nbr; ws[i] = W->s + (size_t)(r + i) * ng; }
  UR FOR_R { UR FOR_T facc[i][j] = vsplatf(0.f); }
  for (int g = 0; g < ng; g++) {
    const int off = g * 32;
    VF ga[MAXR][MAXT];
    UR FOR_T {
      VF c0 = vldf(X->corrf + ((size_t)(t + j) * ng + g) * 4);
      UR FOR_R ga[i][j] = c0;
    }
    UR FOR_R {
      VI raw = vld(w[i] + off / 2);
      VI lo = vand(raw, m0f), hi = vand(vsrl16(raw, 4), m0f);
      VI la = vu8_lo16(lo), lb = vu8_hi16(lo), ha = vu8_lo16(hi), hb = vu8_hi16(hi);
      VF wf[8];
      wf[0] = vcvtf(vu16_lo32(la)); wf[1] = vcvtf(vu16_hi32(la));
      wf[2] = vcvtf(vu16_lo32(lb)); wf[3] = vcvtf(vu16_hi32(lb));
      wf[4] = vcvtf(vu16_lo32(ha)); wf[5] = vcvtf(vu16_hi32(ha));
      wf[6] = vcvtf(vu16_lo32(hb)); wf[7] = vcvtf(vu16_hi32(hb));
      UR FOR_T {
        const float *xp = Xf + (size_t)(t + j) * n + off;
        UR for (int k = 0; k < 8; k++) ga[i][j] = vfma(wf[k], vldf(xp + 4 * k), ga[i][j]);
      }
    }
    UR FOR_R {
      VF sc = vsplatf_mem(ws[i] + g);
      UR FOR_T facc[i][j] = vfma(ga[i][j], sc, facc[i][j]);
    }
  }
  UR FOR_R { UR FOR_T Y[(size_t)(t + j) * W->rows + r + i] = vhsumf(facc[i][j]); }
}
#define C_Q4F(r, t, R, NT) q4f_tile(W, X, Xf, r, t, R, NT, Y)
DEF_DRIVER(k_q4f, C_Q4F, Q4F_MVR, Q4F_MMR, Q4F_MMT)

#if HAVE_RDOT
/* ---- q4 via relaxed dot (u7 nibbles x s8 acts, 16 MACs per instruction) ---- */
AI void q4r_tile(const QMat *W, const QX *X, int r, int t, const int R, const int NT, const int BPG, float *Y) {
  const int n = W->cols, ng = n / (32 * BPG), nbr = n / 2;
  const VI m0f = vset8(0x0F);
  VF facc[MAXR][MAXT];
  const uint8_t *w[MAXR];
  const float *ws[MAXR];
  const int8_t *x[MAXT];
  const int32_t *xc[MAXT];
  UR FOR_R { w[i] = W->q + (size_t)(r + i) * nbr; ws[i] = W->s + (size_t)(r + i) * ng; }
  UR FOR_T { x[j] = X->q8 + (size_t)(t + j) * n; xc[j] = X->corr + (size_t)(t + j) * ng * 4; }
  UR FOR_R { UR FOR_T facc[i][j] = vsplatf(0.f); }
  for (int g = 0; g < ng; g++) {
    VI ia[MAXR][MAXT];
    UR FOR_T {
      VI c0 = vld(xc[j] + 4 * g);
      UR FOR_R ia[i][j] = c0;
    }
    UR for (int b = 0; b < BPG; b++) {
      const int off = (g * BPG + b) * 32;
      VI wl[MAXR], wh[MAXR];
      UR FOR_R {
        VI raw = vld(w[i] + off / 2);
        wl[i] = vand(raw, m0f);
        wh[i] = vand(vsrl16(raw, 4), m0f);
      }
      UR FOR_T {
        VI x0 = vld(x[j] + off), x1 = vld(x[j] + off + 16);
        UR FOR_R ia[i][j] = vrdot(vrdot(ia[i][j], x0, wl[i]), x1, wh[i]);
      }
    }
    UR FOR_R {
      VF sc = vsplatf_mem(ws[i] + g);
      UR FOR_T facc[i][j] = vfma(vcvtf(ia[i][j]), sc, facc[i][j]);
    }
  }
  UR FOR_R { UR FOR_T Y[(size_t)(t + j) * W->rows + r + i] = vhsumf(facc[i][j]) * X->s[t + j]; }
}
#define C_Q4R32(r, t, R, NT) q4r_tile(W, X, r, t, R, NT, 1, Y)
#define C_Q4R64(r, t, R, NT) q4r_tile(W, X, r, t, R, NT, 2, Y)
DEF_DRIVER(k_q4r32, C_Q4R32, Q4R_MVR, Q4R_MMR, Q4R_MMT)
DEF_DRIVER(k_q4r64, C_Q4R64, Q4R_MVR, Q4R_MMR, Q4R_MMT)

/* ---- ternary via relaxed dot ---- */
AI void t2r_tile(const QMat *W, const QX *X, int r, int t, const int R, const int NT, float *Y) {
  const int n = W->cols, nbr = n / 4;
  const VI m3 = vset8(3);
  VI acc[MAXR][MAXT];
  const uint8_t *w[MAXR];
  const int8_t *x[MAXT];
  UR FOR_R w[i] = W->q + (size_t)(r + i) * nbr;
  UR FOR_T x[j] = X->q8 + (size_t)(t + j) * n;
  UR FOR_R { UR FOR_T acc[i][j] = vzero(); }
  for (int c = 0; c < n; c += 64) {
    VI f0[MAXR], f1[MAXR], f2[MAXR], f3[MAXR];
    UR FOR_R {
      VI raw = vld(w[i] + c / 4);
      f0[i] = vand(raw, m3); f1[i] = vand(vsrl16(raw, 2), m3);
      f2[i] = vand(vsrl16(raw, 4), m3); f3[i] = vand(vsrl16(raw, 6), m3);
    }
    UR FOR_T {
      VI x0 = vld(x[j] + c), x1 = vld(x[j] + c + 16), x2 = vld(x[j] + c + 32), x3 = vld(x[j] + c + 48);
      UR FOR_R acc[i][j] = vrdot(vrdot(vrdot(vrdot(acc[i][j], x0, f0[i]), x1, f1[i]), x2, f2[i]), x3, f3[i]);
    }
  }
  UR FOR_R {
    float ws = W->s[r + i];
    UR FOR_T Y[(size_t)(t + j) * W->rows + r + i] =
        (float)(vhsum32(acc[i][j]) - X->sum[t + j]) * ws * X->s[t + j];
  }
}
#define C_T2R(r, t, R, NT) t2r_tile(W, X, r, t, R, NT, Y)
DEF_DRIVER(k_t2r, C_T2R, T2R_MVR, T2R_MMR, T2R_MMT)
#endif /* HAVE_RDOT */

#if defined(NATIVE256) && defined(__AVX2__) && defined(__AVXVNNI__)
/* ---- native-only 256-bit q4 kernel (AVX2 + AVX-VNNI): 64 weights per step, the "what native could do" bound ---- */
AI void q4r256_tile(const QMat *W, const QX *X, int r, int t, const int R, const int NT, const int G64, float *Y) {
  const int n = W->cols, nbr = n / 2, ng = n / (G64 ? 64 : 32);
  const __m256i m0f = _mm256_set1_epi8(0x0F);
  const __m256i lanesel = _mm256_setr_epi32(0, 0, 0, 0, 1, 1, 1, 1);
  __m256 facc[MAXR][MAXT];
  const uint8_t *w[MAXR];
  const float *ws[MAXR];
  const int8_t *x[MAXT];
  const int32_t *xc[MAXT];
  UR FOR_R { w[i] = W->q + (size_t)(r + i) * nbr; ws[i] = W->s + (size_t)(r + i) * ng; }
  UR FOR_T { x[j] = X->q8 + (size_t)(t + j) * n; xc[j] = X->corr + (size_t)(t + j) * ng * 4; }
  UR FOR_R { UR FOR_T facc[i][j] = _mm256_setzero_ps(); }
  for (int k = 0; k < n / 64; k++) {
    const int off = 64 * k;
    __m256i wl[MAXR], wh[MAXR], ia[MAXR][MAXT];
    __m256 sc[MAXR];
    UR FOR_R {
      __m256i raw = _mm256_loadu_si256((const __m256i *)(w[i] + off / 2));
      wl[i] = _mm256_and_si256(raw, m0f);
      wh[i] = _mm256_and_si256(_mm256_srli_epi16(raw, 4), m0f);
      if (G64) sc[i] = _mm256_broadcast_ss(ws[i] + k);
      else sc[i] = _mm256_permutevar8x32_ps(_mm256_castps128_ps256(_mm_castpd_ps(_mm_load_sd((const double *)(ws[i] + 2 * k)))), lanesel);
    }
    UR FOR_T {
      __m256i c0 = G64 ? _mm256_zextsi128_si256(_mm_loadu_si128((const __m128i *)(xc[j] + 4 * k)))
                       : _mm256_loadu_si256((const __m256i *)(xc[j] + 8 * k));
      __m256i x0 = _mm256_loadu_si256((const __m256i *)(x[j] + off)), x1 = _mm256_loadu_si256((const __m256i *)(x[j] + off + 32));
      UR FOR_R ia[i][j] = _mm256_dpbusd_avx_epi32(_mm256_dpbusd_avx_epi32(c0, wl[i], x0), wh[i], x1);
    }
    UR FOR_R { UR FOR_T facc[i][j] = _mm256_fmadd_ps(_mm256_cvtepi32_ps(ia[i][j]), sc[i], facc[i][j]); }
  }
  UR FOR_R {
    UR FOR_T {
      __m256 v = facc[i][j];
      __m128 h = _mm_add_ps(_mm256_castps256_ps128(v), _mm256_extractf128_ps(v, 1));
      Y[(size_t)(t + j) * W->rows + r + i] = vhsumf(h) * X->s[t + j];
    }
  }
}
#define C_Q4W32(r, t, R, NT) q4r256_tile(W, X, r, t, R, NT, 0, Y)
#define C_Q4W64(r, t, R, NT) q4r256_tile(W, X, r, t, R, NT, 1, Y)
DEF_DRIVER(k_q4w32, C_Q4W32, 4, 2, 2)
DEF_DRIVER(k_q4w64, C_Q4W64, 4, 2, 2)
#endif
#endif /* HAVE_SIMD */

static int g_force_i16 = 0, g_force_ref = 0, g_noref = 0;
typedef struct { kern_fn fn; int need8, need16, needcorr, needf, perm; const char *name; } KSel;
static KSel pick_kernel(const QMat *W) {
  KSel k = {k_ref, 0, 0, 0, 0, 0, "ref"};
  int intfmt = W->fmt == F_Q8 || W->fmt == F_Q4 || W->fmt == F_T2;
  if (!HAVE_SIMD || g_force_ref) {
    k.need8 = intfmt;
    return k;
  }
#if HAVE_SIMD
  switch (W->fmt) {
  case F_F32: k.fn = k_f32; k.name = "f32"; break;
  case F_Q8: k.fn = k_q8; k.need16 = 1; k.name = "q8-i16dot"; break;
  case F_Q4F: k.fn = k_q4f; k.needf = 1; k.name = "q4-f32"; break;
  case F_Q4:
    k.needcorr = 1;
#if defined(NATIVE256) && defined(__AVX2__) && defined(__AVXVNNI__)
    if (!g_force_i16) { k.fn = W->gs == 32 ? k_q4w32 : k_q4w64; k.need8 = 1; k.perm = 1; k.name = "q4-vnni256"; break; }
#endif
#if HAVE_RDOT
    if (!g_force_i16) { k.fn = W->gs == 32 ? k_q4r32 : k_q4r64; k.need8 = 1; k.name = "q4-rdot"; break; }
#endif
    k.fn = W->gs == 32 ? k_q4s32 : k_q4s64; k.need16 = 1; k.name = "q4-i16dot";
    break;
  case F_T2:
#if HAVE_RDOT
    if (!g_force_i16) { k.fn = k_t2r; k.need8 = 1; k.name = "t2-rdot"; break; }
#endif
    k.fn = k_t2s; k.need16 = 1; k.name = "t2-i16dot";
    break;
  }
#endif
  return k;
}

typedef struct { kern_fn fn; const QMat *W; const QX *X; const float *Xf; int T; float *Y; } MMJob;
static void mm_task(void *ctx, int tid, int nth) {
  MMJob *j = ctx;
  int rows = j->W->rows, per = (rows + nth - 1) / nth;
  per = (per + 15) & ~15;
  int r0 = tid * per, r1 = r0 + per < rows ? r0 + per : rows;
  if (r0 < r1) j->fn(j->W, j->X, j->Xf, j->T, j->Y, r0, r1);
}
static void qmatmul_q(QX *qx, const QMat *W, const float *X, int T, float *Y) {
  KSel k = pick_kernel(W);
  g_perm8 = k.perm;
  if (k.need8 || k.need16) quant_rows(X, T, W->cols, k.needcorr ? W->gs : 32, k.need8, k.need16, k.needcorr, qx);
  g_perm8 = 0;
  if (k.needf) quant_corrf(X, T, W->cols, qx);
  MMJob j = {k.fn, W, qx, X, T, Y};
  parallel(mm_task, &j);
}

/* ---------------- elementwise helpers ---------------- */
#if HAVE_SIMD
static inline VF vexp(VF x) { /* cephes-style expf, clamped to avoid denormals */
  x = vmaxf(x, vsplatf(-80.f));
  x = vminf(x, vsplatf(80.f));
  VF n = vroundf(vmulf(x, vsplatf(1.44269504088896341f)));
  VF r = vsubf(x, vmulf(n, vsplatf(0.693359375f)));
  r = vsubf(r, vmulf(n, vsplatf(-2.12194440e-4f)));
  VF p = vsplatf(1.9875691500E-4f);
  p = vfma(p, r, vsplatf(1.3981999507E-3f));
  p = vfma(p, r, vsplatf(8.3334519073E-3f));
  p = vfma(p, r, vsplatf(4.1665795894E-2f));
  p = vfma(p, r, vsplatf(1.6666665459E-1f));
  p = vfma(p, r, vsplatf(5.0000001201E-1f));
  p = vfma(p, vmulf(r, r), vaddf(r, vsplatf(1.f)));
  VI e = vshl32(vadd32(vcvti(n), vset32(127)), 23);
  return vmulf(p, vcastif(e));
}
#endif
static void rmsnorm(float *o, const float *x, const float *w, int n) {
  float ss = 0;
#if HAVE_SIMD
  VF a = vsplatf(0.f);
  for (int i = 0; i < n; i += 4) { VF v = vldf(x + i); a = vfma(v, v, a); }
  ss = vhsumf(a);
  VF r = vsplatf(1.f / sqrtf(ss / n + 1e-5f));
  for (int i = 0; i < n; i += 4) vstf(o + i, vmulf(vmulf(vldf(x + i), r), vldf(w + i)));
#else
  for (int i = 0; i < n; i++) ss += x[i] * x[i];
  float r = 1.f / sqrtf(ss / n + 1e-5f);
  for (int i = 0; i < n; i++) o[i] = x[i] * r * w[i];
#endif
}
static void vec_add(float *x, const float *y, size_t n) {
#if HAVE_SIMD
  for (size_t i = 0; i < n; i += 4) vstf(x + i, vaddf(vldf(x + i), vldf(y + i)));
#else
  for (size_t i = 0; i < n; i++) x[i] += y[i];
#endif
}
static void swiglu(float *o, const float *gu, int F) {
#if HAVE_SIMD
  VF one = vsplatf(1.f), zero = vsplatf(0.f);
  for (int i = 0; i < F; i += 4) {
    VF g = vldf(gu + i), u = vldf(gu + F + i);
    vstf(o + i, vmulf(vdivf(g, vaddf(one, vexp(vsubf(zero, g)))), u));
  }
#else
  for (int i = 0; i < F; i++) { float g = gu[i]; o[i] = g / (1.f + expf(-g)) * gu[F + i]; }
#endif
}
static void rope(float *x, int nheads, const float *cs, const float *sn) {
  for (int h = 0; h < nheads; h++) {
    float *xh = x + h * HD;
#if HAVE_SIMD
    for (int i = 0; i < HD / 2; i += 4) {
      VF x1 = vldf(xh + i), x2 = vldf(xh + HD / 2 + i), c = vldf(cs + i), s = vldf(sn + i);
      vstf(xh + i, vsubf(vmulf(x1, c), vmulf(x2, s)));
      vstf(xh + HD / 2 + i, vfma(x1, s, vmulf(x2, c)));
    }
#else
    for (int i = 0; i < HD / 2; i++) {
      float x1 = xh[i], x2 = xh[HD / 2 + i];
      xh[i] = x1 * cs[i] - x2 * sn[i];
      xh[HD / 2 + i] = x2 * cs[i] + x1 * sn[i];
    }
#endif
  }
}

/* ---------------- model ---------------- */
typedef struct {
  float *attn_norm, *ffn_norm;
  QMat wqkv, wo, wgu, wdown;
} Layer;
typedef struct {
  Cfg c; Spec sp;
  int kvd, qkvd, maxn;
  size_t blob_bytes, n_params, n_emb, n_lin;
  uint8_t *blob;
  QMat emb; Layer *L; float *final_norm;
  float *kT, *vc, *rc, *rs;
  uint8_t *kq, *vq; float *ks, *vs; uint8_t *pq; /* int8 KV cache (kv8 mode) */
  float *x, *xn, *qkv, *att, *tmp, *gu, *act, *logits, *sc;
  QX qx;
} Model;

enum { W_SIZE, W_GEN, W_LOAD };
static void gen_mat(uint8_t *p, int fmt, int rows, int cols, int gs) {
  size_t qb = mat_qbytes(fmt, rows, cols), ns = mat_nscales(fmt, rows, cols, gs);
  float base = 0;
  switch (fmt) {
  case F_F32: {
    uint16_t *h = (uint16_t *)p;
    float a = sqrtf(3.f / cols);
    for (size_t i = 0; i < (size_t)rows * cols; i++) h[i] = f32_to_f16((2 * rngf() - 1) * a);
  } break;
  case F_Q8:
    for (size_t i = 0; i < qb; i += 8) {
      uint64_t v = rng();
      for (int k = 0; k < 8; k++) { uint8_t b = (uint8_t)(v >> (8 * k)); p[i + k] = b == 0x80 ? 0x81 : b; }
    }
    base = 1.f / (73.6f * sqrtf((float)cols));
    break;
  case F_Q4: case F_Q4F:
    for (size_t i = 0; i < qb; i += 8) { uint64_t v = rng(); memcpy(p + i, &v, 8); }
    base = 1.f / (4.6f * sqrtf((float)cols));
    break;
  case F_T2:
    for (size_t i = 0; i < qb; i += 8) {
      uint64_t v = rng(), m = v & (v >> 1) & 0x5555555555555555ull; /* fields == 3 -> 1 */
      v &= ~(m << 1);
      memcpy(p + i, &v, 8);
    }
    base = 1.f / (0.707f * sqrtf((float)cols));
    break;
  }
  uint16_t *sc = (uint16_t *)(p + al16(qb));
  for (size_t i = 0; i < ns; i++) sc[i] = f32_to_f16(base * (0.5f + rngf()));
}
static size_t walk_mat(int mode, uint8_t *base, size_t off, QMat *M, int fmt, int rows, int cols, int gs, size_t *np) {
  size_t qb = mat_qbytes(fmt, rows, cols), ns = mat_nscales(fmt, rows, cols, gs);
  *np += (size_t)rows * cols;
  if (mode == W_GEN) gen_mat(base + off, fmt, rows, cols, gs);
  if (mode == W_LOAD) {
    M->fmt = fmt; M->rows = rows; M->cols = cols;
    M->gs = (fmt == F_Q4 || fmt == F_Q4F) ? gs : cols;
    M->q = base + off; M->s = NULL; M->f = NULL;
    if (fmt == F_F32) {
      const uint16_t *h = (const uint16_t *)(base + off);
      size_t n = (size_t)rows * cols;
      M->f = xalloc(n * 4);
      for (size_t i = 0; i < n; i++) M->f[i] = f16_to_f32(h[i]);
    }
    if (ns) {
      const uint16_t *h = (const uint16_t *)(base + off + al16(qb));
      M->s = xalloc(ns * 4);
      for (size_t i = 0; i < ns; i++) M->s[i] = f16_to_f32(h[i]);
    }
  }
  return off + al16(qb) + al16(ns * 2);
}
static size_t walk_vec(int mode, uint8_t *base, size_t off, float **out, int n, size_t *np) {
  *np += n;
  if (mode == W_GEN) for (int i = 0; i < n; i++) ((float *)(base + off))[i] = 1.0f;
  if (mode == W_LOAD) *out = (float *)(base + off);
  return off + al16((size_t)n * 4);
}
static size_t walk_model(int mode, uint8_t *base, Model *m, const Cfg *c, const Spec *sp) {
  size_t off = 0, np = 0, ne = 0, nl = 0;
  int d = c->d, kvd = c->nkv * HD, qd = d + 2 * kvd, F = c->ffn;
  off = walk_mat(mode, base, off, &m->emb, sp->hfmt, c->V, d, sp->hgs, &ne);
  for (int l = 0; l < c->L; l++) {
    Layer *Ly = &m->L[l];
    off = walk_vec(mode, base, off, &Ly->attn_norm, d, &np);
    off = walk_mat(mode, base, off, &Ly->wqkv, sp->bfmt, qd, d, sp->bgs, &nl);
    off = walk_mat(mode, base, off, &Ly->wo, sp->bfmt, d, d, sp->bgs, &nl);
    off = walk_vec(mode, base, off, &Ly->ffn_norm, d, &np);
    off = walk_mat(mode, base, off, &Ly->wgu, sp->bfmt, 2 * F, d, sp->bgs, &nl);
    off = walk_mat(mode, base, off, &Ly->wdown, sp->bfmt, d, F, sp->bgs, &nl);
  }
  off = walk_vec(mode, base, off, &m->final_norm, d, &np);
  m->n_emb = ne; m->n_lin = nl; m->n_params = np + ne + nl;
  return off;
}
static void model_init(Model *m, const Cfg *c, const Spec *sp) {
  memset(m, 0, sizeof *m);
  m->c = *c; m->sp = *sp;
  m->kvd = c->nkv * HD; m->qkvd = c->d + 2 * m->kvd;
  m->maxn = c->d > c->ffn ? c->d : c->ffn;
  m->L = calloc(c->L, sizeof(Layer));
  m->blob_bytes = walk_model(W_SIZE, NULL, m, c, sp);
}
static uint8_t *gen_blob(Model *m) {
  uint8_t *b = xcalloc(m->blob_bytes);
  walk_model(W_GEN, b, m, &m->c, &m->sp);
  return b;
}
static void model_load(Model *m, uint8_t *blob) { m->blob = blob; walk_model(W_LOAD, blob, m, &m->c, &m->sp); }
static int g_kv8; /* int8 attention cache, defined with it below */
static void model_runtime(Model *m) {
  const Cfg *c = &m->c;
  size_t kv = (size_t)c->L * c->nkv * MAXCTX * HD * sizeof(float);
  if (!g_kv8) { /* the f32 cache is only read without kv8 */
    m->kT = xcalloc(kv);
    m->vc = xcalloc(kv);
  }
  m->kq = xcalloc(kv / 4); m->vq = xcalloc(kv / 4);
  m->ks = xcalloc(kv / HD); m->vs = xcalloc(kv / HD);
  m->pq = xcalloc((size_t)MAXTH * MAXCTX);
  m->rc = xalloc(MAXCTX * HD / 2 * 4);
  m->rs = xalloc(MAXCTX * HD / 2 * 4);
  for (int p = 0; p < MAXCTX; p++)
    for (int i = 0; i < HD / 2; i++) {
      double f = pow(10000.0, -2.0 * i / HD) * p;
      m->rc[p * HD / 2 + i] = (float)cos(f);
      m->rs[p * HD / 2 + i] = (float)sin(f);
    }
  int d = c->d, F = c->ffn;
  m->x = xcalloc((size_t)TMAX * d * 4);
  m->xn = xcalloc((size_t)TMAX * d * 4);
  m->qkv = xcalloc((size_t)TMAX * m->qkvd * 4);
  m->att = xcalloc((size_t)TMAX * d * 4);
  m->tmp = xcalloc((size_t)TMAX * d * 4);
  m->gu = xcalloc((size_t)TMAX * 2 * F * 4);
  m->act = xcalloc((size_t)TMAX * F * 4);
  m->logits = xcalloc((size_t)c->V * 4);
  m->sc = xcalloc((size_t)MAXTH * MAXCTX * 4);
  size_t mn = m->maxn;
  m->qx.q8 = xcalloc(TMAX * mn);
  m->qx.q16 = xcalloc(TMAX * mn * 2);
  m->qx.s = xcalloc(TMAX * 4);
  m->qx.sum = xcalloc(TMAX * 4);
  m->qx.corr = xcalloc(TMAX * (mn / 32) * 16);
  m->qx.corrf = xcalloc(TMAX * (mn / 32) * 16);
}

static void embed_row(const QMat *E, int tok, float *o) {
  const int n = E->cols;
  switch (E->fmt) {
  case F_F32: memcpy(o, E->f + (size_t)tok * n, n * 4); break;
  case F_Q8: { const int8_t *w = (const int8_t *)E->q + (size_t)tok * n; float s = E->s[tok];
    for (int c = 0; c < n; c++) o[c] = w[c] * s; } break;
  case F_Q4: case F_Q4F: { const uint8_t *w = E->q + (size_t)tok * n / 2; const float *s = E->s + (size_t)tok * (n / E->gs);
    for (int c = 0; c < n; c++) o[c] = (nib4(w, c) - 8) * s[c / E->gs]; } break;
  case F_T2: { const uint8_t *w = E->q + (size_t)tok * n / 4; float s = E->s[tok];
    for (int c = 0; c < n; c++) o[c] = (t2v(w, c) - 1) * s; } break;
  }
}

/* ---------------- attention ----------------
 * K cache transposed and blocked by 16 positions: kT[l][kvh][pos/16][HD][16]
 * V cache row-major:                               v [l][kvh][pos][HD]       */
static inline float *kT_ptr(Model *m, int l, int h) { return m->kT + (size_t)(l * m->c.nkv + h) * MAXCTX * HD; }
static inline float *v_ptr(Model *m, int l, int h) { return m->vc + (size_t)(l * m->c.nkv + h) * MAXCTX * HD; }
static void kv_store(Model *m, int l, int pos, const float *k, const float *v) {
  for (int h = 0; h < m->c.nkv; h++) {
    float *kt = kT_ptr(m, l, h) + (size_t)(pos >> 4) * HD * 16 + (pos & 15);
    for (int c = 0; c < HD; c++) kt[c * 16] = k[h * HD + c];
    memcpy(v_ptr(m, l, h) + (size_t)pos * HD, v + h * HD, HD * sizeof(float));
  }
}
/* one query head over keys [0, n) */
static void attend_head(const float *kT, const float *V, const float *q, int n, float *out, float *sc) {
  const int nb = (n + 15) >> 4;
#if HAVE_SIMD
  const int np = nb * 16;
  const VF z = vsplatf(0.f), scale = vsplatf(0.125f); /* 1/sqrt(64) */
  for (int b = 0; b < nb; b++) {
    const float *kb = kT + (size_t)b * HD * 16;
    VF a0 = z, a1 = z, a2 = z, a3 = z, b0 = z, b1 = z, b2 = z, b3 = z;
    for (int c = 0; c < HD; c += 2) {
      VF qa = vsplatf_mem(q + c), qb = vsplatf_mem(q + c + 1);
      const float *k0 = kb + c * 16, *k1 = k0 + 16;
      a0 = vfma(qa, vldf(k0), a0); a1 = vfma(qa, vldf(k0 + 4), a1);
      a2 = vfma(qa, vldf(k0 + 8), a2); a3 = vfma(qa, vldf(k0 + 12), a3);
      b0 = vfma(qb, vldf(k1), b0); b1 = vfma(qb, vldf(k1 + 4), b1);
      b2 = vfma(qb, vldf(k1 + 8), b2); b3 = vfma(qb, vldf(k1 + 12), b3);
    }
    float *s = sc + b * 16;
    vstf(s, vmulf(vaddf(a0, b0), scale)); vstf(s + 4, vmulf(vaddf(a1, b1), scale));
    vstf(s + 8, vmulf(vaddf(a2, b2), scale)); vstf(s + 12, vmulf(vaddf(a3, b3), scale));
  }
  for (int i = n; i < np; i++) sc[i] = -1e30f;
  VF mx = vsplatf(-1e30f);
  for (int i = 0; i < np; i += 4) mx = vmaxf(mx, vldf(sc + i));
  VF vm = vsplatf(vhmaxf(mx)), vs = z;
  for (int i = 0; i < np; i += 4) { VF e = vexp(vsubf(vldf(sc + i), vm)); vstf(sc + i, e); vs = vaddf(vs, e); }
  VF inv = vsplatf(1.f / vhsumf(vs));
  for (int c0 = 0; c0 < HD; c0 += 32) {
    VF o[8];
    UR for (int k = 0; k < 8; k++) o[k] = z;
    for (int j = 0; j < n; j++) {
      VF p = vsplatf_mem(sc + j);
      const float *vr = V + (size_t)j * HD + c0;
      UR for (int k = 0; k < 8; k++) o[k] = vfma(p, vldf(vr + 4 * k), o[k]);
    }
    UR for (int k = 0; k < 8; k++) vstf(out + c0 + 4 * k, vmulf(o[k], inv));
  }
#else
  for (int b = 0; b < nb; b++)
    for (int i = 0; i < 16; i++) {
      float a = 0;
      for (int c = 0; c < HD; c++) a += q[c] * kT[(size_t)b * HD * 16 + c * 16 + i];
      sc[b * 16 + i] = a * 0.125f;
    }
  float mx = -1e30f, sum = 0;
  for (int i = 0; i < n; i++) mx = fmaxf(mx, sc[i]);
  for (int i = 0; i < n; i++) { sc[i] = expf(sc[i] - mx); sum += sc[i]; }
  float inv = 1.f / sum;
  for (int c = 0; c < HD; c++) out[c] = 0;
  for (int j = 0; j < n; j++)
    for (int c = 0; c < HD; c++) out[c] += sc[j] * V[(size_t)j * HD + c];
  for (int c = 0; c < HD; c++) out[c] *= inv;
#endif
}
/* ---- int8 attention (kv8 mode) ----
 * K: 7-bit + 64 offset (u7), per-position scale; layout [pos/4][HD/4][4 pos][4 dims] so that one
 *    relaxed dot = 4 positions x 4 dims; q quantized to s8 per head.  score = sq*sk*(dot - 64*sum(q)).
 * V: s8, per-position scale; layout [pos/4][HD/4][4 dims][4 pos].  Probabilities (times the V scale)
 *    are quantized to u7 per query, so  out = sum_j pq_j * vq_j  is again one relaxed dot per 16 MACs. */
static int g_kv8 = 0;
static inline size_t kv8_off(Model *m, int l, int h) { return (size_t)(l * m->c.nkv + h) * MAXCTX; }
static void kv_store8(Model *m, int l, int pos, const float *k, const float *v) {
  for (int h = 0; h < m->c.nkv; h++) {
    const float *kk = k + h * HD, *vv = v + h * HD;
    size_t o = kv8_off(m, l, h);
    float ka = 0, va = 0;
    for (int c = 0; c < HD; c++) { ka = fmaxf(ka, fabsf(kk[c])); va = fmaxf(va, fabsf(vv[c])); }
    float sk = ka > 0 ? ka / 63.f : 1.f, sv = va > 0 ? va / 127.f : 1.f, ik = 1.f / sk, iv = 1.f / sv;
    m->ks[o + pos] = sk; m->vs[o + pos] = sv;
    uint8_t *kb = m->kq + o * HD + (size_t)(pos >> 2) * 256 + (pos & 3) * 4;
    int8_t *vb = (int8_t *)m->vq + o * HD + (size_t)(pos >> 2) * 256 + (pos & 3);
    for (int c = 0; c < HD; c++) {
      kb[(c >> 2) * 16 + (c & 3)] = (uint8_t)((int)rintf(kk[c] * ik) + 64);
      vb[(c >> 2) * 16 + (c & 3) * 4] = (int8_t)rintf(vv[c] * iv);
    }
  }
}
#if HAVE_SIMD && HAVE_RDOT
static void attend_head8(const uint8_t *kq, const float *ks, const int8_t *vq, const float *vs, const float *q, int n,
                         float *out, float *sc, uint8_t *pq) {
  const int nb = (n + 31) >> 5, np = nb * 32;
  /* quantize q */
  float qa = 0;
  for (int c = 0; c < HD; c++) qa = fmaxf(qa, fabsf(q[c]));
  float sq = qa > 0 ? qa / 127.f : 1.f, iq = 1.f / sq;
  int8_t q8[HD];
  int qsum = 0;
  for (int c = 0; c < HD; c++) { int v = (int)rintf(q[c] * iq); q8[c] = (int8_t)v; qsum += v; }
  const VI corr = vset32(64 * qsum);
  const VF fs = vsplatf(sq * 0.125f);
  for (int b = 0; b < nb; b++) {
    const uint8_t *kb = kq + (size_t)b * 8 * 256;
    VI a[8];
    UR for (int k = 0; k < 8; k++) a[k] = vzero();
    for (int dc = 0; dc < HD / 4; dc++) {
      VI qv = vld32_splat(q8 + 4 * dc);
      UR for (int k = 0; k < 8; k++) a[k] = vrdot(a[k], qv, vld(kb + k * 256 + dc * 16));
    }
    UR for (int k = 0; k < 8; k++)
      vstf(sc + b * 32 + 4 * k, vmulf(vmulf(vcvtf(vsub32(a[k], corr)), vldf(ks + b * 32 + 4 * k)), fs));
  }
  for (int i = n; i < np; i++) sc[i] = -1e30f;
  VF mx = vsplatf(-1e30f), mx2 = mx;
  for (int i = 0; i < np; i += 8) { mx = vmaxf(mx, vldf(sc + i)); mx2 = vmaxf(mx2, vldf(sc + i + 4)); }
  VF vm = vsplatf(vhmaxf(vmaxf(mx, mx2))), es = vsplatf(0.f), pm = vsplatf(0.f);
  for (int i = 0; i < np; i += 4) {
    VF e = vexp(vsubf(vldf(sc + i), vm));
    es = vaddf(es, e);
    VF p = vmulf(e, vldf(vs + i));
    vstf(sc + i, p);
    pm = vmaxf(pm, p);
  }
  float pmax = vhmaxf(pm), esum = vhsumf(es);
  VF ps = vsplatf(127.f / pmax);
  for (int i = 0; i < np; i += 16) {
    VI i0 = vcvti(vroundf(vmulf(vldf(sc + i), ps))), i1 = vcvti(vroundf(vmulf(vldf(sc + i + 4), ps)));
    VI i2 = vcvti(vroundf(vmulf(vldf(sc + i + 8), ps))), i3 = vcvti(vroundf(vmulf(vldf(sc + i + 12), ps)));
    vst(pq + i, vpack16(vpack32(i0, i1), vpack32(i2, i3)));
  }
  const VF f = vsplatf(pmax / 127.f / esum);
  const int n4 = (n + 3) >> 2;
  for (int half = 0; half < 2; half++) {
    VI a[8];
    UR for (int k = 0; k < 8; k++) a[k] = vzero();
    for (int j4 = 0; j4 < n4; j4++) {
      VI p = vld32_splat(pq + 4 * j4);
      const int8_t *vb = vq + (size_t)j4 * 256 + half * 128;
      UR for (int k = 0; k < 8; k++) a[k] = vrdot(a[k], vld(vb + 16 * k), p);
    }
    UR for (int k = 0; k < 8; k++) vstf(out + half * 32 + 4 * k, vmulf(vcvtf(a[k]), f));
  }
}
#endif

typedef struct { Model *m; int l, T, pos0; } AttJob;
static void att_task(void *ctx, int tid, int nth) {
  AttJob *j = ctx;
  Model *m = j->m;
  int nh = m->c.nh, G = nh / m->c.nkv, total = j->T * nh;
  float *sc = m->sc + (size_t)tid * MAXCTX;
#if HAVE_SIMD && HAVE_RDOT
  if (g_kv8) {
    uint8_t *pq = m->pq + (size_t)tid * MAXCTX;
    for (int w = tid; w < total; w += nth) {
      int t = w / nh, h = w % nh, kvh = h / G;
      size_t o = kv8_off(m, j->l, kvh);
      attend_head8(m->kq + o * HD, m->ks + o, (const int8_t *)m->vq + o * HD, m->vs + o,
                   m->qkv + (size_t)t * m->qkvd + h * HD, j->pos0 + t + 1, m->att + (size_t)t * m->c.d + h * HD, sc, pq);
    }
    return;
  }
#endif
  for (int w = tid; w < total; w += nth) {
    int t = w / nh, h = w % nh, kvh = h / G;
    attend_head(kT_ptr(m, j->l, kvh), v_ptr(m, j->l, kvh), m->qkv + (size_t)t * m->qkvd + h * HD,
                j->pos0 + t + 1, m->att + (size_t)t * m->c.d + h * HD, sc);
  }
}

/* ---------------- forward ---------------- */
enum { P_MM, P_ATT, P_HEAD, P_OTH, P_N };
static double g_prof[P_N];
static int g_do_prof = 0;
#define PROF(cat, ...)                                   \
  do {                                                   \
    double _t0 = g_do_prof ? now_ms() : 0;               \
    __VA_ARGS__;                                         \
    if (g_do_prof) g_prof[cat] += now_ms() - _t0;        \
  } while (0)

/* process T tokens at positions pos0..pos0+T-1; logits of the last one if want_logits */
static void forward(Model *m, const int *tok, int T, int pos0, int want_logits) {
  const Cfg *c = &m->c;
  const int d = c->d, kvd = m->kvd, qd = m->qkvd, F = c->ffn;
  PROF(P_OTH, for (int t = 0; t < T; t++) embed_row(&m->emb, tok[t], m->x + (size_t)t * d));
  for (int l = 0; l < c->L; l++) {
    Layer *Ly = &m->L[l];
    PROF(P_OTH, for (int t = 0; t < T; t++) rmsnorm(m->xn + (size_t)t * d, m->x + (size_t)t * d, Ly->attn_norm, d));
    PROF(P_MM, qmatmul_q(&m->qx, &Ly->wqkv, m->xn, T, m->qkv));
    PROF(P_OTH, for (int t = 0; t < T; t++) {
      float *q = m->qkv + (size_t)t * qd;
      const float *cs = m->rc + (size_t)(pos0 + t) * HD / 2, *sn = m->rs + (size_t)(pos0 + t) * HD / 2;
      rope(q, c->nh, cs, sn);
      rope(q + d, c->nkv, cs, sn);
      if (g_kv8) kv_store8(m, l, pos0 + t, q + d, q + d + kvd);
      else kv_store(m, l, pos0 + t, q + d, q + d + kvd);
    });
    AttJob aj = {m, l, T, pos0};
    PROF(P_ATT, parallel(att_task, &aj));
    PROF(P_MM, qmatmul_q(&m->qx, &Ly->wo, m->att, T, m->tmp));
    PROF(P_OTH, vec_add(m->x, m->tmp, (size_t)T * d);
         for (int t = 0; t < T; t++) rmsnorm(m->xn + (size_t)t * d, m->x + (size_t)t * d, Ly->ffn_norm, d));
    PROF(P_MM, qmatmul_q(&m->qx, &Ly->wgu, m->xn, T, m->gu));
    PROF(P_OTH, for (int t = 0; t < T; t++) swiglu(m->act + (size_t)t * F, m->gu + (size_t)t * 2 * F, F));
    PROF(P_MM, qmatmul_q(&m->qx, &Ly->wdown, m->act, T, m->tmp));
    PROF(P_OTH, vec_add(m->x, m->tmp, (size_t)T * d));
  }
  if (want_logits) {
    PROF(P_OTH, rmsnorm(m->xn, m->x + (size_t)(T - 1) * d, m->final_norm, d));
    PROF(P_HEAD, qmatmul_q(&m->qx, &m->emb, m->xn, 1, m->logits));
  }
}

static int argmax(const float *x, int n) {
#if HAVE_SIMD
  VF m = vldf(x);
  for (int i = 4; i < n; i += 4) m = vmaxf(m, vldf(x + i));
  float mx = vhmaxf(m);
  for (int i = 0; i < n; i++) if (x[i] == mx) return i;
  return 0;
#else
  int b = 0;
  for (int i = 1; i < n; i++) if (x[i] > x[b]) b = i;
  return b;
#endif
}
/* top-k by insertion into a small sorted list (most elements fail the threshold test) */
static void topk(const float *x, int n, int k, int *idx, float *val) {
  int cnt = 0;
  for (int i = 0; i < n; i++) {
    float v = x[i];
    if (cnt == k && v <= val[k - 1]) continue;
    int p = cnt < k ? cnt++ : k - 1;
    while (p > 0 && val[p - 1] < v) { val[p] = val[p - 1]; idx[p] = idx[p - 1]; p--; }
    val[p] = v; idx[p] = i;
  }
}

/* ---------------- benchmark ---------------- */
static int cmpd(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return x < y ? -1 : x > y; }
static double median(double *v, int n) {
  qsort(v, n, sizeof *v, cmpd);
  return n & 1 ? v[n / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
}
static const Cfg *find_cfg(const char *s) {
  for (size_t i = 0; i < sizeof CFGS / sizeof *CFGS; i++) if (!strcmp(CFGS[i].name, s)) return &CFGS[i];
  fprintf(stderr, "unknown cfg %s\n", s); exit(2);
}
static const Spec *find_spec(const char *s) {
  for (size_t i = 0; i < sizeof SPECS / sizeof *SPECS; i++) if (!strcmp(SPECS[i].name, s)) return &SPECS[i];
  fprintf(stderr, "unknown fmt %s\n", s); exit(2);
}
static double attn_macs(const Cfg *c, int pos0, int T) { /* QK + AV multiply-adds */
  double s = 0;
  for (int t = 0; t < T; t++) s += pos0 + t + 1;
  return s * 2.0 * HD * c->nh * c->L;
}
static const char *build_name(void) {
#if defined(FORCE_SCALAR) && defined(__wasm_simd128__)
  return "wasm-scalar-autovec";
#elif defined(FORCE_SCALAR) && defined(__wasm__)
  return "wasm-scalar";
#elif defined(FORCE_SCALAR)
  return "native-scalar-autovec";
#elif defined(__wasm__) && HAVE_RDOT && defined(WASM_THREADS)
  return "wasm-relaxed-mt";
#elif defined(__wasm__) && HAVE_RDOT
  return "wasm-relaxed";
#elif defined(__wasm__)
  return "wasm-simd128";
#elif defined(NATIVE256) && defined(__AVX2__) && defined(__AVXVNNI__)
  return "native-256-vnni";
#elif defined(__AVXVNNI__) && !defined(NO_VNNI) && defined(USE_THREADS)
  return "native-128-vnni-mt";
#elif defined(__AVXVNNI__) && !defined(NO_VNNI)
  return "native-128-vnni";
#else
  return "native-128";
#endif
}

static int *g_tok;
static double time_fwd(Model *m, const int *tok, int T, int pos0, int logits) {
  double t0 = now_ms();
  forward(m, tok, T, pos0, logits);
  if (logits) argmax(m->logits, m->c.V);
  return now_ms() - t0;
}

static void bench(const Cfg *c, const Spec *sp, int reps, int quick) {
  Model M, *m = &M;
  model_init(m, c, sp);
  rng_s = 0x9E3779B97F4A7C15ull;
  uint8_t *dl = gen_blob(m);
  /* "load": copy downloaded bytes into the (wasm) heap + unpack scales / f16 */
  double t0 = now_ms();
  uint8_t *heap = xalloc(m->blob_bytes);
  memcpy(heap, dl, m->blob_bytes);
  double t_copy = now_ms() - t0;
  free(dl);
  t0 = now_ms();
  model_load(m, heap);
  double t_unpack = now_ms() - t0;
  t0 = now_ms();
  model_runtime(m);
  double t_rt = now_ms() - t0;
  g_tok = xalloc((TMAX + 64) * sizeof(int));
  for (int i = 0; i < TMAX + 64; i++) g_tok[i] = (int)(rng() % c->V);

  /* first-ever calls (cold JIT tier in V8) */
  double t_first16 = time_fwd(m, g_tok, 16, 0, 1);
  double t_first1 = time_fwd(m, g_tok + 16, 1, 16, 1);
  /* warm up */
  for (int k = 0; k < 3; k++) time_fwd(m, g_tok, 64, 0, 1);
  for (int k = 0; k < 8; k++) time_fwd(m, g_tok + 64 + k, 1, 64 + k, 1);

  printf("{\"build\":\"%s\",\"cfg\":\"%s\",\"fmt\":\"%s\",\"threads\":%d,\"attn\":\"%s\"", build_name(), c->name, sp->name, g_nth,
         g_kv8 ? "int8" : "f32");
  KSel kb = pick_kernel(&m->L[0].wqkv), kh = pick_kernel(&m->emb);
  printf(",\"kernel_body\":\"%s\",\"kernel_head\":\"%s\"", kb.name, kh.name);
  printf(",\"params\":%zu,\"params_emb\":%zu,\"params_lin\":%zu,\"download_bytes\":%zu", m->n_params, m->n_emb, m->n_lin, m->blob_bytes);
  printf(",\"load_copy_ms\":%.3f,\"load_unpack_ms\":%.3f,\"runtime_alloc_ms\":%.3f,\"first_prefill16_ms\":%.3f,\"first_decode_ms\":%.3f",
         t_copy, t_unpack, t_rt, t_first16, t_first1);

  /* prefill from an empty cache */
  const int PT[3] = {256, 512, 1024};
  for (int k = 0; k < 3; k++) {
    int T = PT[k];
    double v[16];
    int nr = reps;
    for (int r = 0; r < nr; r++) v[r] = time_fwd(m, g_tok, T, 0, 1);
    double ms = median(v, nr);
    double lin = 2.0 * m->n_lin * T, att = 2.0 * attn_macs(c, 0, T), head = 2.0 * c->V * c->d;
    printf(",\"prefill%d_ms\":%.3f,\"prefill%d_gops_lin\":%.2f,\"prefill%d_gops_all\":%.2f", T, ms, T, lin / ms * 1e-6, T,
           (lin + att + head) / ms * 1e-6);
  }
  { /* profile of a 1024 prefill */
    memset(g_prof, 0, sizeof g_prof); g_do_prof = 1;
    double tot = time_fwd(m, g_tok, 1024, 0, 1);
    g_do_prof = 0;
    printf(",\"prefill1024_prof\":{\"total\":%.3f,\"matmul\":%.3f,\"attn\":%.3f,\"head\":%.3f,\"other\":%.3f}", tot,
           g_prof[P_MM], g_prof[P_ATT], g_prof[P_HEAD], g_prof[P_OTH]);
  }
  /* decode at ~256 and ~1024 */
  const int DP[2] = {256, 1024};
  const int ND = quick ? 8 : 24;
  for (int k = 0; k < 2; k++) {
    int P = DP[k];
    forward(m, g_tok, P, 0, 0);
    double v[64];
    for (int s = 0; s < ND; s++) v[s] = time_fwd(m, g_tok + (P + s) % TMAX, 1, P + s, 1);
    double ms = median(v, ND);
    memset(g_prof, 0, sizeof g_prof); g_do_prof = 1;
    double tp = 0;
    for (int s = 0; s < ND; s++) tp += time_fwd(m, g_tok + (P + s) % TMAX, 1, P + s, 1);
    g_do_prof = 0;
    printf(",\"decode%d_ms\":%.4f,\"decode%d_prof\":{\"total\":%.4f,\"matmul\":%.4f,\"attn\":%.4f,\"head\":%.4f,\"other\":%.4f}",
           P, ms, P, tp / ND, g_prof[P_MM] / ND, g_prof[P_ATT] / ND, g_prof[P_HEAD] / ND, g_prof[P_OTH] / ND);
  }
  { /* LM head alone, argmax, top-k */
    rmsnorm(m->xn, m->x, m->final_norm, c->d);
    const int NR = 41;
    double v[41], va[41], vt[41];
    int idx[40]; float val[40];
    for (int r = 0; r < NR; r++) {
      double a = now_ms();
      qmatmul_q(&m->qx, &m->emb, m->xn, 1, m->logits);
      double b = now_ms();
      volatile int am = argmax(m->logits, c->V); (void)am;
      double e = now_ms();
      topk(m->logits, c->V, 40, idx, val);
      double f = now_ms();
      v[r] = b - a; va[r] = e - b; vt[r] = f - e;
    }
    printf(",\"head_ms\":%.4f,\"argmax_ms\":%.4f,\"top40_ms\":%.4f", median(v, NR), median(va, NR), median(vt, NR));
  }
  { /* scenario: 1024 cached + 3 typed tokens (incremental prefill) + 12 greedy tokens */
    forward(m, g_tok, 1024, 0, 0);
    double vt[8], vtot[8];
    int nr = quick ? 3 : 7;
    for (int r = 0; r < nr; r++) {
      double a = now_ms();
      forward(m, g_tok + 900, 3, 1024, 1);
      int nt = argmax(m->logits, c->V);
      vt[r] = now_ms() - a;
      for (int s = 0; s < 11; s++) { forward(m, &nt, 1, 1027 + s, 1); nt = argmax(m->logits, c->V); }
      vtot[r] = now_ms() - a;
    }
    printf(",\"warm_ttft_ms\":%.3f,\"warm_total_ms\":%.3f", median(vt, nr), median(vtot, nr));
    /* cold: full 1024 prefill + 12 tokens */
    nr = quick ? 1 : (reps < 3 ? reps : 3);
    for (int r = 0; r < nr; r++) {
      double a = now_ms();
      forward(m, g_tok, 1024, 0, 1);
      int nt = argmax(m->logits, c->V);
      vt[r] = now_ms() - a;
      for (int s = 0; s < 11; s++) { forward(m, &nt, 1, 1024 + s, 1); nt = argmax(m->logits, c->V); }
      vtot[r] = now_ms() - a;
    }
    printf(",\"cold_ttft_ms\":%.3f,\"cold_total_ms\":%.3f", median(vt, nr), median(vtot, nr));
  }
  printf("}\n");
  fflush(stdout);
}

/* ---------------- kernel microbenchmark ---------------- */
static void kern(const Cfg *c, const Spec *sp) {
  Model M, *m = &M;
  /* build a model with only one layer worth of weights */
  Cfg c1 = *c; c1.L = 1; c1.V = 64;
  model_init(m, &c1, sp);
  uint8_t *b = gen_blob(m);
  model_load(m, b);
  model_runtime(m);
  QMat *mats[2] = {&m->L[0].wgu, &m->L[0].wdown};
  const char *mn[2] = {"gate_up", "down"};
  float *X = xalloc((size_t)256 * m->maxn * 4), *Y = xalloc((size_t)256 * 2 * c->ffn * 4);
  for (size_t i = 0; i < (size_t)256 * m->maxn; i++) X[i] = 2 * rngf() - 1;
  for (int k = 0; k < 2; k++) {
    QMat *W = mats[k];
    for (int path = 0; path < 3; path++) {
      g_force_ref = path == 2; g_force_i16 = path == 1;
      if (path == 1 && !(HAVE_RDOT && (W->fmt == F_Q4 || W->fmt == F_T2))) continue;
      if (path == 2 && (HAVE_SIMD == 0 || g_noref)) continue;
      KSel ks = pick_kernel(W);
      int Ts[2] = {1, 256};
      for (int q = 0; q < 2; q++) {
        int T = Ts[q], nr = T == 1 ? 400 : 6;
        if (path == 2) nr = T == 1 ? 20 : 1;
        qmatmul_q(&m->qx, W, X, T, Y);
        double v[400];
        for (int r = 0; r < nr; r++) { double a = now_ms(); qmatmul_q(&m->qx, W, X, T, Y); v[r] = now_ms() - a; }
        double ms = median(v, nr);
        printf("{\"build\":\"%s\",\"cfg\":\"%s\",\"fmt\":\"%s\",\"mat\":\"%s\",\"rows\":%d,\"cols\":%d,\"T\":%d,\"kernel\":\"%s\",\"ms\":%.4f,\"gops\":%.2f,\"wbytes_per_s_GB\":%.2f}\n",
               build_name(), c->name, sp->name, mn[k], W->rows, W->cols, T, ks.name, ms, 2.0 * W->rows * W->cols * T / ms * 1e-6,
               T == 1 ? (double)mat_qbytes(W->fmt, W->rows, W->cols) * (W->fmt == F_F32 ? 2 : 1) / ms * 1e-6 : 0.0);
      }
    }
  }
  g_force_ref = g_force_i16 = 0;
}

/* attention microbenchmark: one head over n keys */
static void attn_bench(void) {
  const int n = 1024;
  float *kT = xcalloc((size_t)MAXCTX * HD * 4), *V = xcalloc((size_t)MAXCTX * HD * 4), q[HD], out[HD];
  float *sc = xcalloc(MAXCTX * 4);
  for (int i = 0; i < MAXCTX * HD; i++) { kT[i] = rngf() - 0.5f; V[i] = rngf() - 0.5f; }
  for (int i = 0; i < HD; i++) q[i] = rngf() - 0.5f;
  for (int r = 0; r < 200; r++) attend_head(kT, V, q, n, out, sc);
  double v[50];
  for (int r = 0; r < 50; r++) {
    double a = now_ms();
    for (int k = 0; k < 20; k++) attend_head(kT, V, q, n, out, sc);
    v[r] = (now_ms() - a) / 20;
  }
  double ms = median(v, 50);
#if HAVE_SIMD && HAVE_RDOT
  if (g_kv8) {
    uint8_t *kq = xalloc(MAXCTX * HD), *vq = xalloc(MAXCTX * HD), *pq = xalloc(MAXCTX);
    float *ks = xalloc(MAXCTX * 4), *vs = xalloc(MAXCTX * 4);
    for (int i = 0; i < MAXCTX * HD; i++) { kq[i] = (uint8_t)(rng() % 127 + 1); vq[i] = (uint8_t)(rng() % 255 + 129); }
    for (int i = 0; i < MAXCTX; i++) { ks[i] = 0.01f; vs[i] = 0.01f; }
    for (int r = 0; r < 200; r++) attend_head8(kq, ks, (int8_t *)vq, vs, q, n, out, sc, pq);
    for (int r = 0; r < 50; r++) {
      double a = now_ms();
      for (int k = 0; k < 20; k++) attend_head8(kq, ks, (int8_t *)vq, vs, q, n, out, sc, pq);
      v[r] = (now_ms() - a) / 20;
    }
    ms = median(v, 50);
  }
#endif
  printf("{\"build\":\"%s\",\"attn\":\"%s\",\"attn_head_n\":%d,\"us\":%.3f,\"gmacs\":%.2f}\n", build_name(), g_kv8 ? "int8" : "f32", n, ms * 1e3, 2.0 * n * HD / ms * 1e-6);
}

/* ---------------- tests ---------------- */
static int test_kernels(void) {
  int bad = 0;
  const int rows = 64, T = 7;
  const int colsv[2] = {640, 1728};
  for (size_t s = 0; s < sizeof SPECS / sizeof *SPECS; s++)
    for (int ci = 0; ci < 2; ci++) {
      int cols = colsv[ci], fmt = SPECS[s].bfmt, gs = SPECS[s].bgs;
      size_t nb = al16(mat_qbytes(fmt, rows, cols)) + al16(mat_nscales(fmt, rows, cols, gs) * 2), np = 0;
      uint8_t *b = xcalloc(nb);
      QMat W;
      walk_mat(W_GEN, b, 0, &W, fmt, rows, cols, gs, &np);
      walk_mat(W_LOAD, b, 0, &W, fmt, rows, cols, gs, &np);
      QX qx = {xalloc(T * cols), xalloc(T * cols * 2), xalloc(T * 4), xalloc(T * 4), xalloc(T * cols / 32 * 16), xalloc(T * cols / 32 * 16)};
      float *X = xalloc(T * cols * 4), *Y0 = xalloc(T * rows * 4), *Y1 = xalloc(T * rows * 4);
      for (int i = 0; i < T * cols; i++) X[i] = 2 * rngf() - 1;
      g_force_ref = 1;
      qmatmul_q(&qx, &W, X, T, Y0);
      g_force_ref = 0;
      for (int path = 0; path < 2; path++) {
        g_force_i16 = path;
        KSel k = pick_kernel(&W);
        for (int Tt = 1; Tt <= T; Tt += T - 1) {
          qmatmul_q(&qx, &W, X, Tt, Y1);
          double err = 0, mag = 0;
          for (int i = 0; i < Tt * rows; i++) { err = fmax(err, fabs(Y1[i] - Y0[i])); mag = fmax(mag, fabs(Y0[i])); }
          int ok = err <= 1e-4 * mag + 1e-6;
          bad += !ok;
          printf("kernel %-6s cols=%4d T=%d %-10s max|err|=%.3g (max|y|=%.3g) %s\n", SPECS[s].name, cols, Tt, k.name, err, mag, ok ? "ok" : "FAIL");
        }
      }
      g_force_i16 = 0;
    }
  return bad;
}
static int test_forward(void) {
  int bad = 0;
  const Cfg *c = find_cfg("tiny");
  for (size_t s = 0; s < sizeof SPECS / sizeof *SPECS; s++) {
    Model M, *m = &M;
    model_init(m, c, &SPECS[s]);
    rng_s = 12345;
    model_load(m, gen_blob(m));
    model_runtime(m);
    int tok[48];
    for (int i = 0; i < 48; i++) tok[i] = (int)(rng() % c->V);
    float *ref = xalloc(c->V * 4);
    forward(m, tok, 40, 0, 1);
    memcpy(ref, m->logits, c->V * 4);
    forward(m, tok, 21, 0, 1);
    for (int t = 21; t < 40; t++) forward(m, tok + t, 1, t, 1);
    double err = 0, mag = 0, sum = 0;
    for (int i = 0; i < c->V; i++) { err = fmax(err, fabs(m->logits[i] - ref[i])); mag = fmax(mag, fabs(ref[i])); sum += ref[i]; }
    int ok = err <= 1e-4 * mag;
    bad += !ok;
    printf("forward %-6s prefill(40) vs prefill(21)+19 decodes: max|err|=%.3g max|logit|=%.3g  argmax=%d checksum=%.6f %s\n",
           SPECS[s].name, err, mag, argmax(ref, c->V), sum, ok ? "ok" : "FAIL");
#if HAVE_SIMD && HAVE_RDOT
    /* int8 attention: self-consistency, and distance to the f32-attention logits */
    g_kv8 = 1;
    float *r8 = xalloc(c->V * 4);
    forward(m, tok, 40, 0, 1);
    memcpy(r8, m->logits, c->V * 4);
    forward(m, tok, 21, 0, 1);
    for (int t = 21; t < 40; t++) forward(m, tok + t, 1, t, 1);
    double e8 = 0, d8 = 0, n2 = 0;
    for (int i = 0; i < c->V; i++) {
      e8 = fmax(e8, fabs(m->logits[i] - r8[i]));
      d8 += (r8[i] - ref[i]) * (r8[i] - ref[i]); n2 += ref[i] * ref[i];
    }
    ok = e8 <= 1e-4 * mag;
    bad += !ok;
    printf("forward %-6s kv8: prefill vs decode max|err|=%.3g %s;  rel-L2 vs f32 attention = %.4f, argmax %d vs %d\n",
           SPECS[s].name, e8, ok ? "ok" : "FAIL", sqrt(d8 / n2), argmax(r8, c->V), argmax(ref, c->V));
    g_kv8 = 0;
#endif
  }
  return bad;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IOLBF, 0);
  if (argc < 2) {
    fprintf(stderr, "usage: llm test | bench <cfg> <fmt> [reps] [quick] | kern <cfg> <fmt>\n"
                    "env-free flags: append 'i16' to force the i16-dot kernels, 'ref' for the C reference, 'th=N' for threads\n");
    return 2;
  }
  int reps = 3, quick = 0;
  for (int i = 2; i < argc; i++) {
    if (!strcmp(argv[i], "i16")) g_force_i16 = 1;
    else if (!strcmp(argv[i], "ref")) g_force_ref = 1;
    else if (!strcmp(argv[i], "quick")) quick = 1;
    else if (!strcmp(argv[i], "noref")) g_noref = 1;
    else if (!strcmp(argv[i], "kv8")) g_kv8 = HAVE_RDOT && HAVE_SIMD;
    else if (!strncmp(argv[i], "th=", 3)) pool_start(atoi(argv[i] + 3));
    else if (!strncmp(argv[i], "reps=", 5)) reps = atoi(argv[i] + 5);
  }
  if (!strcmp(argv[1], "test")) {
    int bad = test_kernels() + test_forward();
    printf("%s (%s): %d failures\n", build_name(), TARGET, bad);
    return bad != 0;
  }
  if (!strcmp(argv[1], "bench") && argc >= 4) { bench(find_cfg(argv[2]), find_spec(argv[3]), reps, quick); return 0; }
  if (!strcmp(argv[1], "attn")) { attn_bench(); return 0; }
  if (!strcmp(argv[1], "kern") && argc >= 4) { kern(find_cfg(argv[2]), find_spec(argv[3])); return 0; }
  fprintf(stderr, "bad args\n");
  return 2;
}
