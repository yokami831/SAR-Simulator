"""Benchmark batch-mode Verilator FFT throughput."""
import os, sys, time, numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from verilator_fft_drive import (
    export_verilog, verilate_build, run_fft_batch, to_q15, Q15, _BUILD_ROOT
)

def bench(N, Na, seed=0):
    v = export_verilog(N)
    build_dir = os.path.join(_BUILD_ROOT, f"vbuild_{N}")
    exe = verilate_build(N, v, build_dir)

    rng = np.random.default_rng(seed)
    x = (rng.standard_normal((Na, N)) + 1j * rng.standard_normal((Na, N))) * 0.1
    x_re = np.round(np.clip(x.real, -1.0, 1.0 - 1.0/Q15) * Q15).astype(np.int16)
    x_im = np.round(np.clip(x.imag, -1.0, 1.0 - 1.0/Q15) * Q15).astype(np.int16)

    hw, elapsed, info = run_fft_batch(exe, N, x_re, x_im)

    # Verify against numpy on first row
    x_q15_first = x_re[0].astype(np.float64)/Q15 + 1j*x_im[0].astype(np.float64)/Q15
    ref0 = np.fft.fft(x_q15_first)
    err0 = np.abs(hw[0] - ref0)
    sig0 = np.sqrt(np.mean(np.abs(ref0)**2))
    snr0 = 20*np.log10(sig0 / (np.sqrt(np.mean(err0**2)) + 1e-30))

    per_frame_ms = elapsed * 1000 / Na
    print(f"[batch] N={N:>5} Na={Na:>4} total={elapsed*1000:>7.0f}ms  per_frame={per_frame_ms:>6.2f}ms  SNR_row0={snr0:.1f}dB   {info}")

if __name__ == '__main__':
    for N, Na in [(1024, 100), (4096, 100), (8192, 100), (8192, 2016)]:
        bench(N, Na)
