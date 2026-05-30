"""Bit-accurate Vivado FFT IP (xfft v9.1) range-compression route.

This is the C-model analogue of `verilator_route_b.route_b_pipeline`. Instead
of the Amaranth/Verilator FFT + cupy Q-format quantizers, it runs the Xilinx
xfft v9.1 IP bit-accurate C-model (pipelined streaming, 16-bit, Block Floating
Point, truncation) via `xfft_cmodel.xfft` / `xfft_batch`.

It is a verification reference for a real Vivado xfft IP instance: a SAR
range-compression pipeline (FFT x chirp-spectrum multiply x IFFT) reproduced
with the exact IP arithmetic. Standalone — does NOT touch HiyoCanvas / the
canvas / any .rcflow, and does NOT run Vivado.

Design notes (mirrors route_b_pipeline philosophy):
  * The IP datapath is a single 16-bit (Q1.15) bus with BFP carrying internal
    growth, so there is NO separate Q_IN/Q_FFT/Q_OUT staging — the one 16-bit
    datapath + per-transform block exponent model the real hardware.
  * Every data-dependent scale we apply on the host is a POWER-OF-2 bit-shift
    only (a real shift register set per scene), aiming for ~half full-scale
    (SCALE_TARGET=0.5) headroom — never an arbitrary float that would flatter
    the quantization by perfectly filling the range.
  * C-model conventions (verified in xfft_cmodel.py):
      - returned array is RAW BFP-normalized; true value = y * 2**(+blk_exp)
        (POSITIVE exponent, per-transform / per-row).
      - the IP inverse transform is UNSCALED = np.fft.ifft(x)*N (no 1/N); to
        match the standard 1/N inverse used by route_b_pipeline / the float
        route, divide the recovered IFFT by N.
      - model input MUST be pre-quantized into [-1, 1) (16-bit). We pre-scale
        into range first.
"""
from __future__ import annotations

import math
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from xfft_cmodel import xfft, xfft_batch  # noqa: E402

# Reuse the realistic-fixed-point pre-scale knobs from the Verilator route so
# the two routes share the exact same power-of-2 / half-full-scale philosophy.
# (Imported, not redefined, to keep a single source of truth.)
from verilator_route_b import SCALE_TARGET, _pow2_scale  # noqa: E402


def _next_pow2(n: int) -> int:
    return 1 << (n - 1).bit_length()


def route_vivado_ip(fir_coefficients, ref_chirp, verbose=True):
    """Bit-accurate Vivado xfft IP range-compression route (FFT*mult*IFFT).

    Mirrors route_b_pipeline but the FFT/IFFT are the Xilinx xfft v9.1 IP
    bit-accurate C-model (pipelined, 16-bit, Block Floating Point, truncation).
    The IP is 16-bit throughout with BFP handling internal growth, so there is
    no separate Q_IN/Q_FFT/Q_OUT staging — the single 16-bit datapath + BFP
    block exponent model the real hardware.

    fir_coefficients : (Na, Nr) complex   (Nr a power of 2, 8..65536)
    ref_chirp        : (Nr,)   complex
    Returns s_raw : (Na, Nr) complex64, in the SAME normalization convention as
    route_b_pipeline / the float route (np.fft.ifft 1/N convention).
    """
    fir_coefficients = np.asarray(fir_coefficients, dtype=np.complex64)
    ref_chirp = np.asarray(ref_chirp, dtype=np.complex64).reshape(-1)
    if fir_coefficients.ndim != 2:
        raise ValueError(f"fir_coefficients must be 2-D (Na, Nr); got {fir_coefficients.shape}")
    Na, Nr = fir_coefficients.shape
    if ref_chirp.shape[0] != Nr:
        raise ValueError(f"ref_chirp length {ref_chirp.shape[0]} != Nr {Nr}")

    # 1. Validate Nr is a power of 2 in [8, 65536] (IP transform length limits).
    if Nr < 8 or Nr > 65536 or (Nr & (Nr - 1)) != 0:
        raise ValueError(f"Nr must be a power of 2 in [8, 65536]; got {Nr}")

    if verbose:
        print(f"  route_vivado_ip: Nr={Nr}, Na={Na}  (Xilinx xfft v9.1 16-bit BFP trunc)")

    # ------------------------------------------------------------------
    # Stage A: bring the FFT inputs into the IP's [-1,1) range with a
    # POWER-OF-2 pre-scale (a real per-scene shift register), targeting
    # ~SCALE_TARGET full-scale. The IP itself does the 16-bit Q1.15
    # quantization internally (quantize_q15). Pre-scales are powers of 2 =
    # exact, so we undo them after recovery with no error.
    # ------------------------------------------------------------------
    fir_peak = float(np.maximum(np.abs(fir_coefficients.real).max(),
                                np.abs(fir_coefficients.imag).max()))
    chirp_peak = float(np.maximum(np.abs(ref_chirp.real).max(),
                                  np.abs(ref_chirp.imag).max()))
    fir_pre = _pow2_scale(fir_peak, SCALE_TARGET)
    chirp_pre = _pow2_scale(chirp_peak, SCALE_TARGET)

    fir_in = fir_coefficients * fir_pre
    chirp_in = ref_chirp * chirp_pre

    # ------------------------------------------------------------------
    # 3. FFT (direction=1). Recover true magnitude with 2**(+blk_exp) and
    #    undo the input pre-scale so F and C are at natural FFT magnitude.
    # ------------------------------------------------------------------
    F_raw, be_f = xfft_batch(fir_in, 1)
    F = (F_raw.astype(np.complex128) * (2.0 ** be_f.astype(np.float64))[:, None]) / fir_pre

    C_raw, be_c = xfft(chirp_in, 1)
    C = (C_raw.astype(np.complex128) * (2.0 ** be_c)) / chirp_pre

    if verbose:
        _log_shift("Stage A fir  pre", fir_pre, extra=f"peak={fir_peak:.3g}")
        _log_shift("Stage A chirp pre", chirp_pre, extra=f"peak={chirp_peak:.3g}")
        print(f"  FFT blk_exp: fir be range [{int(be_f.min())},{int(be_f.max())}]  "
              f"chirp be={int(be_c)}")

    # ------------------------------------------------------------------
    # 4. Multiply in the frequency domain (natural scale).
    # ------------------------------------------------------------------
    prod = F * C[None, :]

    # ------------------------------------------------------------------
    # 5. IFFT (direction=0). prod must be re-scaled into [-1,1) for the IP,
    #    again with a power-of-2 pre-scale. After recovery: * 2**(+blk_exp),
    #    undo the prod pre-scale, and divide by Nr (IP IFFT is unscaled =
    #    ifft*N, but route_b_pipeline / float use the 1/N convention).
    # ------------------------------------------------------------------
    prod_peak = float(np.maximum(np.abs(prod.real).max(), np.abs(prod.imag).max()))
    prod_pre = _pow2_scale(prod_peak, SCALE_TARGET)
    prod_in = (prod * prod_pre).astype(np.complex64)

    s_raw_raw, be_o = xfft_batch(prod_in, 0)
    s_raw = (s_raw_raw.astype(np.complex128) * (2.0 ** be_o.astype(np.float64))[:, None])
    s_raw = s_raw / prod_pre / Nr  # undo prod pre-scale + 1/N inverse convention

    if verbose:
        _log_shift("Stage C prod pre", prod_pre, extra=f"peak={prod_peak:.3g}")
        print(f"  IFFT blk_exp: out be range [{int(be_o.min())},{int(be_o.max())}]")

    s_raw = s_raw.astype(np.complex64)
    if verbose:
        print(f"  s_raw={s_raw.shape}  peak|s|={float(np.abs(s_raw).max()):.4f}")
    return s_raw


def _log_shift(name: str, scale: float, extra: str = "") -> None:
    shift = int(round(math.log2(scale))) if scale > 0 else 0
    if scale >= 1:
        sc = f"x{scale:g} (<<{shift})"
    else:
        sc = f"x{scale:g} (>>{-shift})"
    print(f"  {name}: pre-scale {sc}  {extra}".rstrip())


if __name__ == "__main__":
    # quick smoke test
    rng = np.random.default_rng(0)
    Na, Nr = 4, 4096
    fir = ((rng.standard_normal((Na, Nr)) + 1j * rng.standard_normal((Na, Nr))) * 0.01).astype(np.complex64)
    fir[:, 100] += 1.0 + 0.5j
    n = np.arange(Nr)
    chirp = np.exp(1j * np.pi * 4e5 * (n - Nr / 2) ** 2 / Nr ** 2).astype(np.complex64)
    chirp[np.abs(n - Nr / 2) > 1500] = 0
    s = route_vivado_ip(fir, chirp)
    print("smoke peak|s| =", float(np.abs(s).max()))
