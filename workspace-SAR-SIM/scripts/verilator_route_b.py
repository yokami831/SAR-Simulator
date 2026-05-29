"""Python primitives for using the Amaranth/Verilator FFT inside the SAR flow.

Provides `verilator_fft` and `verilator_ifft` — drop-in (but power-of-2 only)
replacements for np.fft.fft / np.fft.ifft along the last axis. Builds the
Verilator executable once per N (cached), then batches many rows through it.

Typical use in a flow node:

    from verilator_route_b import verilator_fft, verilator_ifft

    # fir_coefficients shape (Na, Nr), Nr must be power of 2
    F = verilator_fft(fir_coefficients)
    prod = F * chirp_fft[None, :]
    s_raw = verilator_ifft(prod)
"""
import os
import sys
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from verilator_fft_drive import (
    export_verilog, verilate_build, run_fft_batch, Q15, _BUILD_ROOT,
)

# Cache one Verilator exe per N (build is ~20s the first time).
_EXE_CACHE: dict = {}

def _get_exe(N: int) -> str:
    if N in _EXE_CACHE:
        return _EXE_CACHE[N]
    v = export_verilog(N)
    build_dir = os.path.join(_BUILD_ROOT, f"vbuild_{N}")
    exe = verilate_build(N, v, build_dir)
    _EXE_CACHE[N] = exe
    return exe


def _next_pow2(n: int) -> int:
    return 1 << (n - 1).bit_length()


def verilator_fft(x: np.ndarray) -> np.ndarray:
    """FFT along axis -1 using the Amaranth/Verilator hardware reference.

    Length N must be a power of 2; pad the caller side if not. Output has
    the same shape as input.
    """
    x = np.asarray(x, dtype=np.complex64)
    *batch_dims, N = x.shape
    if (N & (N - 1)) != 0:
        raise ValueError(f"verilator_fft requires power-of-2 N, got {N}")

    flat = x.reshape(-1, N)
    Na = flat.shape[0]
    exe = _get_exe(N)

    # Block-scale the input so every batch fits comfortably in Q1.15 range
    # ([-1, 1)) without clipping; undo on the way out.
    peak = float(np.max(np.maximum(np.abs(flat.real), np.abs(flat.imag))))
    in_scale = (0.95 / peak) if peak > 0 else 1.0

    scaled = flat * in_scale
    re = np.clip(np.round(scaled.real * Q15), -32768, 32767).astype(np.int16)
    im = np.clip(np.round(scaled.imag * Q15), -32768, 32767).astype(np.int16)

    hw, _elapsed, _info = run_fft_batch(exe, N, re, im)
    hw = hw / in_scale
    return hw.astype(np.complex64).reshape(*batch_dims, N)


def verilator_ifft(x: np.ndarray) -> np.ndarray:
    """IFFT along axis -1 via FFT(conj)/N. Same power-of-2 restriction."""
    x = np.asarray(x, dtype=np.complex64)
    N = x.shape[-1]
    if (N & (N - 1)) != 0:
        raise ValueError(f"verilator_ifft requires power-of-2 N, got {N}")
    res = verilator_fft(x.conj())
    return (res.conj() / N).astype(np.complex64)


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
def _self_test(N=1024, Na=4, seed=0):
    rng = np.random.default_rng(seed)
    x = (rng.standard_normal((Na, N)) + 1j * rng.standard_normal((Na, N))) * 0.1
    x = x.astype(np.complex64)
    y_hw = verilator_fft(x)
    y_np = np.fft.fft(x, axis=-1)
    err = np.abs(y_hw - y_np)
    sig = np.sqrt(np.mean(np.abs(y_np) ** 2))
    snr = 20 * np.log10(sig / (np.sqrt(np.mean(err ** 2)) + 1e-30))
    print(f"verilator_fft  Na={Na} N={N}  max_err={err.max():.4g}  SNR={snr:.1f} dB")

    z_hw = verilator_ifft(y_hw)
    err2 = np.abs(z_hw - x)
    sig2 = np.sqrt(np.mean(np.abs(x) ** 2))
    snr2 = 20 * np.log10(sig2 / (np.sqrt(np.mean(err2 ** 2)) + 1e-30))
    print(f"verilator_ifft round-trip  max_err={err2.max():.4g}  SNR={snr2:.1f} dB")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1024
    na = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    _self_test(N=n, Na=na)
