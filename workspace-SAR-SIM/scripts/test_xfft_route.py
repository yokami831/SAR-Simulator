"""Verify xfft_route.route_vivado_ip against the float-ideal range compression.

Run with:  .venv\\Scripts\\python.exe workspace-SAR-SIM\\scripts\\test_xfft_route.py

The Vivado xfft IP C-model route should reproduce the float-ideal
FFT*mult*IFFT to within 16-bit/BFP/truncation quantization (~50-77 dB), and
crucially must NOT be off by a power-of-2 factor (which would be a blk_exp /
normalization bookkeeping bug).
"""
from __future__ import annotations

import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from xfft_route import route_vivado_ip  # noqa: E402
from xfft_cmodel import xfft  # noqa: E402


def _make_scene(Na=4, Nr=4096, seed=0):
    rng = np.random.default_rng(seed)
    # small random complex background with one dominant tap
    fir = ((rng.standard_normal((Na, Nr)) + 1j * rng.standard_normal((Na, Nr))) * 0.01).astype(np.complex64)
    fir[:, 100] += 1.0 + 0.5j  # dominant tap
    # windowed LFM reference chirp
    n = np.arange(Nr)
    chirp = np.exp(1j * np.pi * 4e5 * (n - Nr / 2) ** 2 / Nr ** 2).astype(np.complex64)
    chirp[np.abs(n - Nr / 2) > 1500] = 0.0
    return fir, chirp


def test_route_vs_float_ideal():
    Na, Nr = 4, 4096
    fir, chirp = _make_scene(Na, Nr)

    # float-ideal range compression (1/N inverse convention)
    s_ideal = np.fft.ifft(np.fft.fft(fir, axis=1) * np.fft.fft(chirp)[None, :], axis=1)

    print("--- route_vivado_ip ---")
    s_hw = route_vivado_ip(fir, chirp, verbose=True)

    err = np.linalg.norm(s_hw - s_ideal)
    sig = np.linalg.norm(s_ideal)
    snr = 20.0 * np.log10(sig / (err + 1e-30))

    peak_hw = float(np.abs(s_hw).max())
    peak_ideal = float(np.abs(s_ideal).max())
    peak_ratio = peak_hw / peak_ideal

    print()
    print(f"  ||s_ideal||      = {sig:.6g}")
    print(f"  ||s_hw - s_ideal|| = {err:.6g}")
    print(f"  SNR vs float-ideal = {snr:.2f} dB")
    print(f"  peak|s_hw|   = {peak_hw:.6g}")
    print(f"  peak|s_ideal| = {peak_ideal:.6g}")
    print(f"  peak_ratio   = {peak_ratio:.6f}")

    # A clean power-of-2 ratio would mean a normalization/blk_exp bug.
    log2r = np.log2(peak_ratio)
    near_pow2 = abs(log2r - round(log2r)) < 0.02 and abs(round(log2r)) >= 1
    if near_pow2:
        print(f"  !! peak_ratio is ~2^{round(log2r)} — normalization/blk_exp bug")

    ok_snr = snr >= 40.0
    ok_ratio = 0.7 < peak_ratio < 1.4
    ok = ok_snr and ok_ratio and not near_pow2
    print(f"  [{'PASS' if ok else 'FAIL'}] SNR>=40dB:{ok_snr}  0.7<ratio<1.4:{ok_ratio}  "
          f"not-pow2:{not near_pow2}")
    return ok


def test_single_tone_fft():
    """DC/scale sanity: a single-tone input FFT lands in the right bin at the
    right magnitude (recovered via the C-model blk_exp convention)."""
    N = 4096
    k0 = 37
    n = np.arange(N)
    amp = 0.4
    x = (amp * np.exp(2j * np.pi * k0 * n / N)).astype(np.complex64)  # in [-1,1)

    Y_raw, be = xfft(x, 1)
    Y = Y_raw.astype(np.complex128) * (2.0 ** be)

    mag = np.abs(Y)
    peak_bin = int(np.argmax(mag))
    peak_val = mag[peak_bin]
    expected = amp * N  # FFT of a pure tone -> impulse of height amp*N

    print("--- single-tone FFT sanity ---")
    print(f"  expected bin={k0}, got bin={peak_bin}")
    print(f"  expected |Y[k0]|={expected:.3g}, got {peak_val:.3g}  "
          f"ratio={peak_val/expected:.4f}")

    ok_bin = peak_bin == k0
    ok_mag = 0.7 < peak_val / expected < 1.4
    ok = ok_bin and ok_mag
    print(f"  [{'PASS' if ok else 'FAIL'}] bin:{ok_bin}  mag:{ok_mag}")
    return ok


if __name__ == "__main__":
    r1 = test_route_vs_float_ideal()
    print()
    r2 = test_single_tone_fft()
    print()
    allok = r1 and r2
    print(f"=== OVERALL: {'PASS' if allok else 'FAIL'} ===")
    sys.exit(0 if allok else 1)
