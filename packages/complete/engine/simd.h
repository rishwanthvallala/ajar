/* simd.h - a thin 128-bit SIMD layer so the same kernels compile to
 *   - wasm SIMD128 (wasm_simd128.h), optionally with relaxed-simd, and
 *   - native x86 SSE4.1/AVX2/FMA (+AVX-VNNI) intrinsics, 128-bit wide,
 * i.e. "same algorithm, same vector width" for the wasm/native comparison.
 * All macros so shift counts stay immediates.
 *
 *   VI / VF          integer / float 128-bit vectors (same type on wasm)
 *   vrdot(acc,a,b)   acc + sum of 4 adjacent products a[i]*b[i]; a: s8, b: u7 (0..127)
 *                    = wasm i32x4.relaxed_dot_i8x16_i7x16_add_s / x86 vpdpbusd
 */
#pragma once
#include <stdint.h>

#if defined(FORCE_SCALAR)
#define HAVE_SIMD 0
#define HAVE_RDOT 0

#elif defined(__wasm_simd128__)
#include <wasm_simd128.h>
#define HAVE_SIMD 1
typedef v128_t VI;
typedef v128_t VF;
#define vld(p)          wasm_v128_load((const void *)(p))
#define vst(p, v)       wasm_v128_store((void *)(p), (v))
#define vld8_u16(p)     wasm_u16x8_load8x8((const void *)(p))
#define vld8_i16(p)     wasm_i16x8_load8x8((const void *)(p))
#define vand(a, b)      wasm_v128_and((a), (b))
#define vsrl16(a, n)    wasm_u16x8_shr((a), (n))
#define vset8(x)        wasm_i8x16_splat(x)
#define vset16(x)       wasm_i16x8_splat(x)
#define vset32(x)       wasm_i32x4_splat(x)
#define vzero()         wasm_i32x4_splat(0)
#define vdot16(a, b)    wasm_i32x4_dot_i16x8((a), (b))
#define vadd32(a, b)    wasm_i32x4_add((a), (b))
#define vadd16(a, b)    wasm_i16x8_add((a), (b))
#define vsub32(a, b)    wasm_i32x4_sub((a), (b))
#define vld32_splat(p)  wasm_v128_load32_splat((const void *)(p))
#define vshl32(a, n)    wasm_i32x4_shl((a), (n))
#define vpack32(a, b)   wasm_i16x8_narrow_i32x4((a), (b))
#define vpack16(a, b)   wasm_i8x16_narrow_i16x8((a), (b))
#define vldf(p)         wasm_v128_load((const void *)(p))
#define vstf(p, v)      wasm_v128_store((void *)(p), (v))
#define vsplatf(x)      wasm_f32x4_splat(x)
#define vsplatf_mem(p)  wasm_v128_load32_splat((const void *)(p))
#define vaddf(a, b)     wasm_f32x4_add((a), (b))
#define vsubf(a, b)     wasm_f32x4_sub((a), (b))
#define vmulf(a, b)     wasm_f32x4_mul((a), (b))
#define vdivf(a, b)     wasm_f32x4_div((a), (b))
#define vmaxf(a, b)     wasm_f32x4_pmax((a), (b))
#define vminf(a, b)     wasm_f32x4_pmin((a), (b))
#define vabsf(a)        wasm_f32x4_abs(a)
#define vroundf(a)      wasm_f32x4_nearest(a)
#define vcvtf(a)        wasm_f32x4_convert_i32x4(a)
#define vcastif(a)      (a)
#define vcastfi(a)      (a)
#define vu8_lo16(a)     wasm_u16x8_extend_low_u8x16(a)
#define vu8_hi16(a)     wasm_u16x8_extend_high_u8x16(a)
#define vu16_lo32(a)    wasm_u32x4_extend_low_u16x8(a)
#define vu16_hi32(a)    wasm_u32x4_extend_high_u16x8(a)
#ifdef __wasm_relaxed_simd__
#define HAVE_RDOT 1
#define vrdot(acc, a, b) wasm_i32x4_relaxed_dot_i8x16_i7x16_add((a), (b), (acc))
#define vfma(a, b, c)    wasm_f32x4_relaxed_madd((a), (b), (c)) /* a*b+c */
#define vcvti(a)         wasm_i32x4_relaxed_trunc_f32x4(a)
#else
#define HAVE_RDOT 0
#define vfma(a, b, c)    wasm_f32x4_add(wasm_f32x4_mul((a), (b)), (c))
#define vcvti(a)         wasm_i32x4_trunc_sat_f32x4(a)
#endif
static inline int32_t vhsum32(VI v) {
  v = wasm_i32x4_add(v, wasm_i32x4_shuffle(v, v, 2, 3, 0, 1));
  v = wasm_i32x4_add(v, wasm_i32x4_shuffle(v, v, 1, 0, 3, 2));
  return wasm_i32x4_extract_lane(v, 0);
}
static inline float vhsumf(VF v) {
  v = wasm_f32x4_add(v, wasm_i32x4_shuffle(v, v, 2, 3, 0, 1));
  v = wasm_f32x4_add(v, wasm_i32x4_shuffle(v, v, 1, 0, 3, 2));
  return wasm_f32x4_extract_lane(v, 0);
}
static inline float vhmaxf(VF v) {
  v = wasm_f32x4_pmax(v, wasm_i32x4_shuffle(v, v, 2, 3, 0, 1));
  v = wasm_f32x4_pmax(v, wasm_i32x4_shuffle(v, v, 1, 0, 3, 2));
  return wasm_f32x4_extract_lane(v, 0);
}

#elif defined(__SSE4_1__)
#include <immintrin.h>
#define HAVE_SIMD 1
typedef __m128i VI;
typedef __m128 VF;
#define vld(p)          _mm_loadu_si128((const __m128i *)(p))
#define vst(p, v)       _mm_storeu_si128((__m128i *)(p), (v))
#define vld8_u16(p)     _mm_cvtepu8_epi16(_mm_loadl_epi64((const __m128i *)(p)))
#define vld8_i16(p)     _mm_cvtepi8_epi16(_mm_loadl_epi64((const __m128i *)(p)))
#define vand(a, b)      _mm_and_si128((a), (b))
#define vsrl16(a, n)    _mm_srli_epi16((a), (n))
#define vset8(x)        _mm_set1_epi8(x)
#define vset16(x)       _mm_set1_epi16(x)
#define vset32(x)       _mm_set1_epi32(x)
#define vzero()         _mm_setzero_si128()
#define vdot16(a, b)    _mm_madd_epi16((a), (b))
#define vadd32(a, b)    _mm_add_epi32((a), (b))
#define vadd16(a, b)    _mm_add_epi16((a), (b))
#define vsub32(a, b)    _mm_sub_epi32((a), (b))
static inline __m128i vld32_splat(const void *p) { int32_t v; __builtin_memcpy(&v, p, 4); return _mm_set1_epi32(v); }
#define vshl32(a, n)    _mm_slli_epi32((a), (n))
#define vpack32(a, b)   _mm_packs_epi32((a), (b))
#define vpack16(a, b)   _mm_packs_epi16((a), (b))
#define vldf(p)         _mm_loadu_ps((const float *)(p))
#define vstf(p, v)      _mm_storeu_ps((float *)(p), (v))
#define vsplatf(x)      _mm_set1_ps(x)
#define vsplatf_mem(p)  _mm_broadcast_ss((const float *)(p))
#define vaddf(a, b)     _mm_add_ps((a), (b))
#define vsubf(a, b)     _mm_sub_ps((a), (b))
#define vmulf(a, b)     _mm_mul_ps((a), (b))
#define vdivf(a, b)     _mm_div_ps((a), (b))
#define vmaxf(a, b)     _mm_max_ps((a), (b))
#define vminf(a, b)     _mm_min_ps((a), (b))
#define vabsf(a)        _mm_andnot_ps(_mm_set1_ps(-0.0f), (a))
#define vroundf(a)      _mm_round_ps((a), _MM_FROUND_TO_NEAREST_INT | _MM_FROUND_NO_EXC)
#define vcvtf(a)        _mm_cvtepi32_ps(a)
#define vcvti(a)        _mm_cvttps_epi32(a)
#define vcastif(a)      _mm_castsi128_ps(a)
#define vcastfi(a)      _mm_castps_si128(a)
#define vu8_lo16(a)     _mm_cvtepu8_epi16(a)
#define vu8_hi16(a)     _mm_unpackhi_epi8((a), _mm_setzero_si128())
#define vu16_lo32(a)    _mm_cvtepu16_epi32(a)
#define vu16_hi32(a)    _mm_unpackhi_epi16((a), _mm_setzero_si128())
#define HAVE_RDOT 1
#if defined(__AVXVNNI__) && !defined(NO_VNNI)
#define vrdot(acc, a, b) _mm_dpbusd_avx_epi32((acc), (b), (a))
#else
#define vrdot(acc, a, b) _mm_add_epi32((acc), _mm_madd_epi16(_mm_maddubs_epi16((b), (a)), _mm_set1_epi16(1)))
#endif
#ifdef __FMA__
#define vfma(a, b, c)   _mm_fmadd_ps((a), (b), (c))
#else
#define vfma(a, b, c)   _mm_add_ps(_mm_mul_ps((a), (b)), (c))
#endif
static inline int32_t vhsum32(VI v) {
  v = _mm_add_epi32(v, _mm_shuffle_epi32(v, 0x4e));
  v = _mm_add_epi32(v, _mm_shuffle_epi32(v, 0xb1));
  return _mm_cvtsi128_si32(v);
}
static inline float vhsumf(VF v) {
  v = _mm_add_ps(v, _mm_movehl_ps(v, v));
  v = _mm_add_ss(v, _mm_movehdup_ps(v));
  return _mm_cvtss_f32(v);
}
static inline float vhmaxf(VF v) {
  v = _mm_max_ps(v, _mm_movehl_ps(v, v));
  v = _mm_max_ss(v, _mm_movehdup_ps(v));
  return _mm_cvtss_f32(v);
}
#else
#error "no SIMD backend: build with -msimd128 (wasm) or -march=native (x86), or -DFORCE_SCALAR"
#endif
