"""Hardware-faithful (bit-exact) Python model of the SAR ECHO-SYNTHESIS datapath.

This is the SPEC / reference for the Vivado RTL `echo_datapath.sv`. It stays
entirely in the INTEGER / 16-bit-code domain (NOT recovered float, unlike
xfft_route.route_vivado_ip) so it matches the real RTL bit-for-bit:

    fir (Q1.15 codes)
       -> xfft_fwd  (forward FFT, xfft_cmodel)    -> F codes (16-bit) + be_fwd
       -> cmpy:  P = F * Hcoef   (33-bit EXACT integer complex multiply on codes)
       -> SHIFT (arith >> SHIFT, truncate to 16-bit)   -> Pq codes (Q1.15)
       -> xfft_inv  (inverse FFT, xfft_cmodel)    -> s_raw codes (16-bit) + be_inv

ECHO SYNTHESIS (reflection-wave / HIL target simulator), NOT range compression:
the multiply coefficient is the FORWARD chirp spectrum  chirp_fft = FFT(ref_chirp)
(NOT a conjugate / matched filter).

Conventions (verified bit-exact against xfft_0 xsim by gen_xsim_vectors.py /
tb_xfft.sv):
  * xfft_cmodel.xfft returns RAW BFP-normalized float in [-1,1); the 16-bit bus
    CODE is  trunc(raw * 32768)  (truncate toward zero).  block exponent be is
    reported separately on m_axis_data_tuser.
  * cmpy_0: APortWidth=16, BPortWidth=16, OutputWidth=33, Truncate. The product
    re/im is the EXACT integer  F_re*H_re - F_im*H_im  /  F_re*H_im + F_im*H_re
    on the 16-bit codes (fits in 33 bits, no rounding). On the bus each component
    occupies 40 bits (sign-extended 33-bit) -> {im[79:40], re[39:0]}.
  * SHIFT: arithmetic right shift of the 33-bit product, then take the low 16
    bits = truncate toward -inf (drop low SHIFT bits). Result is a Q1.15 code.
"""
from __future__ import annotations

import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from xfft_cmodel import xfft  # noqa: E402

Q15 = 32768.0


# --------------------------------------------------------------------------
# code <-> float conversions (EXACTLY as the verified gen_xsim_vectors flow)
# --------------------------------------------------------------------------
def code_from_q15(v: float) -> int:
    """[-1,1) float -> signed 16-bit code, truncate toward zero, saturate."""
    c = int(np.trunc(v * Q15))
    if c > 32767:
        c = 32767
    if c < -32768:
        c = -32768
    return c


def codes_from_raw(y: np.ndarray) -> np.ndarray:
    """Vectorized: RAW BFP complex float array (in [-1,1)) -> (re_code, im_code)
    int32 arrays, truncate toward zero + saturate (matches code_from_q15)."""
    re = np.trunc(np.asarray(y).real * Q15).astype(np.int64)
    im = np.trunc(np.asarray(y).imag * Q15).astype(np.int64)
    re = np.clip(re, -32768, 32767).astype(np.int32)
    im = np.clip(im, -32768, 32767).astype(np.int32)
    return re, im


def to_u16(code: int) -> int:
    return int(code) & 0xFFFF


# --------------------------------------------------------------------------
# Reference chirp + coefficient ROM
# --------------------------------------------------------------------------
def make_ref_chirp(N: int) -> np.ndarray:
    """Windowed LFM transmit chirp, length N (documented for N=1024).

    chirp[n] = exp(1j*pi*4e5*(n-N/2)^2/N^2) for |n-N/2| <= HALF, else 0.
    Window HALF = N*3/8 (= 384 for N=1024): a centered raised pulse occupying
    3/4 of the aperture (matches the gen_xsim_vectors / test_xfft_route family
    of windowed LFMs). Peak |chirp| = 1.0 inside the window.
    """
    n = np.arange(N)
    chirp = np.exp(1j * np.pi * 4e5 * (n - N / 2.0) ** 2 / N ** 2)
    half = (N * 3) // 8
    chirp[np.abs(n - N / 2.0) > half] = 0.0
    return chirp.astype(np.complex64)


def build_coef_rom(ref_chirp: np.ndarray, be_coef: int):
    """chirp_fft = xfft_cmodel.xfft(ref_chirp, 1) (forward FFT on the IP bus
    scale), then block-scaled by a power-of-2 be_coef and quantized to a Q1.15
    ROM so its peak ~0.5 FS. ROM bin k aligns with xfft_fwd natural-order bin k.

    Returns (Hre_codes int32[N], Him_codes int32[N], chirp_fft_be) where
    chirp_fft_be is the C-model's own block exponent for the chirp FFT (for the
    record; the ROM itself is at the chosen be_coef scale).
    """
    # ref_chirp peak is 1.0 -> already in [-1,1); pre-quantize handled by xfft.
    C_raw, be_c = xfft(ref_chirp, 1)          # RAW BFP float in [-1,1)
    # Recover true forward-FFT magnitude, then re-scale by chosen be_coef.
    C_true = C_raw.astype(np.complex128) * (2.0 ** be_c)
    H = C_true * (2.0 ** (-be_coef))          # block-scale by 2**-be_coef
    Hre, Him = codes_from_raw(H)              # Q1.15 codes for the ROM
    return Hre, Him, int(be_c)


# --------------------------------------------------------------------------
# Integer cmpy + shift (exact RTL arithmetic)
# --------------------------------------------------------------------------
def cmpy_int(Fre, Fim, Hre, Him):
    """Exact 33-bit integer complex multiply on 16-bit codes (cmpy_0 Truncate).
    Returns (Pre, Pim) int64 arrays (each fits in 33 bits)."""
    Fre = Fre.astype(np.int64); Fim = Fim.astype(np.int64)
    Hre = Hre.astype(np.int64); Him = Him.astype(np.int64)
    Pre = Fre * Hre - Fim * Him
    Pim = Fre * Him + Fim * Hre
    return Pre, Pim


def arith_shift_to_q15(P, shift: int):
    """Arithmetic right shift the 33-bit product by `shift`, take low 16 bits =
    truncate toward -inf. Returns signed 16-bit code int32 array.

    NOTE on truncation direction: a Verilog `>>>` (arithmetic) on a signed value
    truncates toward -inf (floor), which numpy `>>` on int64 also does. We then
    take the low 16 bits as a two's-complement signed value (wrap), matching the
    RTL `Pq = $signed(P >>> SHIFT) [15:0]`.
    """
    P = np.asarray(P, dtype=np.int64)
    q = P >> shift                       # arithmetic (floor) shift, like Verilog >>>
    # take low 16 bits, interpret as signed two's complement (wrap = RTL [15:0])
    u = (q & 0xFFFF).astype(np.int64)
    signed = np.where(u >= 0x8000, u - 0x10000, u).astype(np.int32)
    return signed


# --------------------------------------------------------------------------
# Top-level model
# --------------------------------------------------------------------------
def echo_datapath(fir_complex, ref_chirp, N: int, be_coef: int, shift: int,
                  verbose: bool = True):
    """Bit-exact echo-synthesis datapath (single pulse, length N).

    fir_complex : (N,) complex, Q1.15 (peak < 1) scene impulse for ONE pulse
    ref_chirp   : (N,) complex transmit chirp (peak ~1.0)
    be_coef     : power-of-2 block exponent for the coefficient ROM
    shift       : 33->16 arithmetic right shift

    Returns (s_raw_codes_complex int16[N], debug dict).
    s_raw_codes_complex.real/imag are the 16-bit IFFT output codes (the bus
    values), be_inv is on debug. The COMPARISON is on these codes + be_inv.
    """
    fir_complex = np.asarray(fir_complex, dtype=np.complex64).reshape(-1)
    ref_chirp = np.asarray(ref_chirp, dtype=np.complex64).reshape(-1)
    assert fir_complex.shape[0] == N and ref_chirp.shape[0] == N

    # ---- coefficient ROM (chirp_fft, forward FFT) ----
    Hre, Him, be_chirp = build_coef_rom(ref_chirp, be_coef)

    # ---- Stage 1: forward FFT of fir ----
    F_raw, be_fwd = xfft(fir_complex, 1)             # RAW BFP float
    Fre, Fim = codes_from_raw(F_raw)                 # 16-bit bus codes

    # ---- cmpy: F * Hcoef (33-bit exact) ----
    Pre, Pim = cmpy_int(Fre, Fim, Hre, Him)

    # ---- Stage 2a: shift 33->16 (Q1.15) ----
    Pqre = arith_shift_to_q15(Pre, shift)
    Pqim = arith_shift_to_q15(Pim, shift)

    # ---- Stage 2b: inverse FFT of Pq ----
    Pq = (Pqre.astype(np.float64) / Q15) + 1j * (Pqim.astype(np.float64) / Q15)
    s_raw_raw, be_inv = xfft(Pq, 0)
    Sre, Sim = codes_from_raw(s_raw_raw)

    s_codes = (Sre.astype(np.int16)) + 1j * (Sim.astype(np.int16))
    # numpy has no complex int16; keep re/im separately too
    debug = {
        "be_fwd": int(be_fwd),
        "be_coef": int(be_coef),
        "be_chirp": int(be_chirp),
        "shift": int(shift),
        "be_inv": int(be_inv),
        "Fre": Fre, "Fim": Fim,
        "Hre": Hre, "Him": Him,
        "Pre": Pre, "Pim": Pim,
        "Pqre": Pqre, "Pqim": Pqim,
        "Sre": Sre, "Sim": Sim,
        "P_peak": int(np.max(np.abs(np.concatenate([Pre, Pim])))),
        "Pq_peak": int(np.max(np.abs(np.concatenate([Pqre, Pqim])))),
        "H_peak": int(np.max(np.abs(np.concatenate([Hre, Him])))),
        "F_peak": int(np.max(np.abs(np.concatenate([Fre, Fim])))),
    }
    if verbose:
        print(f"  echo_datapath N={N}: be_fwd={be_fwd} be_coef={be_coef} "
              f"shift={shift} be_inv={be_inv}")
        print(f"  F_peak={debug['F_peak']} H_peak={debug['H_peak']} "
              f"P_peak={debug['P_peak']} (33b max={2**32}) "
              f"Pq_peak={debug['Pq_peak']} (16b max=32767)")
    return s_codes, debug


def make_fir(N: int) -> np.ndarray:
    """Deterministic single-pulse scene impulse (Q1.15, peak ~0.3) for the test
    vector. A few bright point scatterers + small clutter floor; same style as
    the verified gen_xsim_vectors deterministic input."""
    rng = np.random.default_rng(12345)
    fir = ((rng.standard_normal(N) + 1j * rng.standard_normal(N)) * 0.01).astype(np.complex64)
    # a few bright scatterers
    fir[100] += 0.25 + 0.10j
    fir[400] += -0.18 + 0.20j
    fir[777] += 0.15 - 0.22j
    # scale so peak ~0.3
    peak = float(np.max(np.abs(fir)))
    fir = (fir / peak * 0.3).astype(np.complex64)
    return fir


if __name__ == "__main__":
    N = 1024
    fir = make_fir(N)
    chirp = make_ref_chirp(N)
    s, dbg = echo_datapath(fir, chirp, N, be_coef=0, shift=15)
    print("peak|s_code| =", int(np.max(np.abs(np.concatenate([dbg['Sre'], dbg['Sim']])))))
