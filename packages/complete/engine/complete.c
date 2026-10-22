/* complete.c - the completion engine as a library: llm.c's kernels, one model and one KV cache, driven
 * from JavaScript (../src/engine.ts), which owns the tokenizer, the prompt and the decoding loop.
 *
 *   pc_init(V, d, L, nh, nkv, ffn)  the model's shape; returns the size of the blob it implies
 *   pc_blob()                        where the caller writes the blob (q4g64, scripts/export_engine.py)
 *   pc_load(threads)                 parse it and allocate the cache; threads > 1 only in the -mt builds
 *   pc_tokens()                      int32[TMAX], the input of the next pc_forward
 *   pc_forward(n, pos0, logits)      n <= TMAX tokens at positions pos0.., the last one's logits if asked;
 *                                    the cache keeps everything before pos0, so a prompt that shares a
 *                                    beginning with the last one only runs what is new
 *   pc_mask()                        uint8[V], for the caller to fill as pc_pick's allowed
 *   pc_pick(n, allowed)              argmax of the first n logits, of those with allowed[i] != 0 when
 *                                    allowed is not 0; its log-probability is left in pc_lp()
 *
 * The same kernels and numerics as the measured engine (e2e.c): kv8 attention when relaxed SIMD is there,
 * f32 attention otherwise. Chunked prefill gives the same results as one call: activations are quantized
 * per token. */
#define main llm_main
#include "llm.c"
#undef main

#define EXPORT(name) __attribute__((export_name(#name)))
/* Below this many tokens a forward pass runs on one thread: waking the pool costs more than it saves. */
#define PAR_MIN 16

static Cfg g_cfg;
static Model g_m;
static uint8_t *g_blob, *g_mask;
static int g_tokbuf[TMAX];
static float g_lp;
static int g_threads = 1;

EXPORT(pc_init) int pc_init(int V, int d, int L, int nh, int nkv, int ffn) {
  g_cfg = (Cfg){"real", V, d, L, nh, nkv, ffn};
  model_init(&g_m, &g_cfg, find_spec("q4g64"));
  g_blob = xalloc(g_m.blob_bytes);
  g_mask = xcalloc(V);
  return (int)g_m.blob_bytes;
}
EXPORT(pc_blob) uint8_t *pc_blob(void) { return g_blob; }
EXPORT(pc_mask) uint8_t *pc_mask(void) { return g_mask; }
EXPORT(pc_load) int pc_load(int threads) {
  g_kv8 = HAVE_RDOT && HAVE_SIMD;
  model_load(&g_m, g_blob);
  model_runtime(&g_m);
#ifdef WASM_THREADS
  pool_start(threads);
  g_threads = g_nth;
#else
  (void)threads;
#endif
  return 0;
}
EXPORT(pc_tokens) int *pc_tokens(void) { return g_tokbuf; }
EXPORT(pc_logits) float *pc_logits(void) { return g_m.logits; }
EXPORT(pc_tmax) int pc_tmax(void) { return TMAX; }
EXPORT(pc_maxctx) int pc_maxctx(void) { return MAXCTX; }
EXPORT(pc_threads) int pc_threads(void) { return g_threads; }
EXPORT(pc_kv8) int pc_kv8(void) { return g_kv8; }
EXPORT(pc_lp) float pc_lp(void) { return g_lp; }

EXPORT(pc_forward) int pc_forward(int n, int pos0, int logits) {
  if (n < 1 || n > TMAX || pos0 < 0 || pos0 + n > MAXCTX) return -1;
#ifdef WASM_THREADS
  g_nth = n >= PAR_MIN ? g_threads : 1;
#endif
  forward(&g_m, g_tokbuf, n, pos0, logits);
  return 0;
}

EXPORT(pc_pick) int pc_pick(int n, const uint8_t *allowed) {
  const float *x = g_m.logits;
  int b = -1;
  float mx = -INFINITY, s = 0;
  if (allowed) {
    for (int i = 0; i < n; i++) if (allowed[i] && x[i] > mx) { mx = x[i]; b = i; }
    if (b < 0) { g_lp = -INFINITY; return -1; }
    for (int i = 0; i < n; i++) if (allowed[i]) s += expf(x[i] - mx);
  } else {
    b = 0;
    for (int i = 1; i < n; i++) if (x[i] > x[b]) b = i;
    mx = x[b];
    int i = 0;
#if HAVE_SIMD
    VF a = vsplatf(0.f), m4 = vsplatf(mx);
    for (; i + 4 <= n; i += 4) a = vaddf(a, vexp(vsubf(vldf(x + i), m4)));
    s = vhsumf(a);
#endif
    for (; i < n; i++) s += expf(x[i] - mx);
  }
  g_lp = -logf(s);
  return b;
}
