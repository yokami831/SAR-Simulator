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
import math
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
# Route B equivalent — Stage A/B/C quantization wrapped around Verilator FFT.
# Mirrors backend/SAR n43 Route B's qz() semantics with Q-format parameters
# (default matches the documented Route B defaults: Q1.9 / Q8.10 / Q1.9).
# ---------------------------------------------------------------------------

def quantize_fixed(x: np.ndarray, n_word: int, n_frac: int) -> np.ndarray:
    """Fixed Q-format quantize (no auto-scale). Clip + round to full-scale.

    Used for Stage A (ADC) and Stage C (DAC) where the FS reference is part
    of the analog design and shouldn't be rescaled per-frame.
    """
    step = 2.0 ** (-n_frac)
    iv_max =  (1 << (n_word - 1)) - 1
    iv_min = -(1 << (n_word - 1))
    re = np.clip(np.round(x.real / step), iv_min, iv_max) * step
    im = np.clip(np.round(x.imag / step), iv_min, iv_max) * step
    return (re + 1j * im).astype(np.complex64)


def quantize_bfp(x: np.ndarray, n_word: int, n_frac: int,
                 return_shift: bool = False):
    """Block quantize with a POWER-OF-2 bit-shift (realistic, FPGA-implementable).

    The host (which knows the loaded coefficients) computes, per scene/block, the
    largest integer bit-shift that keeps the block peak within 0.95*FS, and passes
    it to the FPGA as a RUNTIME PARAMETER alongside the coefficients. The HDL
    datapath itself is fixed (synthesised once); only the shift register changes
    per scene. This matches e.g. Xilinx FFT IP "scaled" mode.

        shift = floor(log2(0.95 * FS / peak))     # left(+) / right(-) bit shift
        s     = 2**shift                          # power-of-2 only (a real shift)

    Returns the quantized array (and the integer shift if return_shift=True).
    Because shift is chosen on the known data, overflow does not occur; the
    residual error is the Q-format bit-width quantization noise.
    """
    full_scale = 2 ** (n_word - 1 - n_frac)
    step = 2.0 ** (-n_frac)
    iv_max =  (1 << (n_word - 1)) - 1
    iv_min = -(1 << (n_word - 1))
    peak = float(np.maximum(np.abs(x.real).max(), np.abs(x.imag).max()))
    if peak == 0:
        return (x.astype(np.complex64), 0) if return_shift else x.astype(np.complex64)
    shift = int(math.floor(math.log2(0.95 * full_scale / peak)))   # power-of-2 bit shift
    s = 2.0 ** shift
    re = np.clip(np.round(x.real * s / step), iv_min, iv_max) * step / s
    im = np.clip(np.round(x.imag * s / step), iv_min, iv_max) * step / s
    q = (re + 1j * im).astype(np.complex64)
    return (q, shift) if return_shift else q


def route_b_pipeline(
    fir_coefficients: np.ndarray,
    ref_chirp: np.ndarray,
    Q_IN=(10, 9),
    Q_FFT=(18, 10),
    Q_OUT=(10, 9),
    N_FFT: int = None,
    verbose: bool = True,
):
    """Bit-exact gate-level Route B (FFT × multiply × IFFT with per-stage Q quantize).

    Mirrors n43 Route B but with the FFT/IFFT step done by the Verilator-
    compiled Amaranth FFT instead of cupy.fft. Stage A/B/C quantization is
    applied in Python (cupy on real FPGA, here numpy for portability).

    Inputs:
        fir_coefficients : (Na, Nr) complex   — time-domain FIR taps from n32
        ref_chirp        : (Nr,)   complex   — baseband reference chirp
        Q_IN, Q_FFT, Q_OUT: (n_word, n_frac) per stage

    Returns:
        s_raw : (Na, Nr) complex64, cropped back to original Nr.
    """
    Na, Nr = fir_coefficients.shape
    # FFT size: caller-supplied fixed FPGA size N_FFT (synthesis-time constant),
    # else next_pow2(Nr). Must hold at least the receive window.
    Nr_p2 = int(N_FFT) if N_FFT else _next_pow2(Nr)
    if Nr_p2 < Nr:
        raise ValueError(f"N_FFT={Nr_p2} < Nr={Nr}: FFT smaller than receive window")
    if verbose:
        print(f"  Q_IN=Q{Q_IN[0]-Q_IN[1]}.{Q_IN[1]}  Q_FFT=Q{Q_FFT[0]-Q_FFT[1]}.{Q_FFT[1]}  Q_OUT=Q{Q_OUT[0]-Q_OUT[1]}.{Q_OUT[1]}")
        print(f"  Nr={Nr} -> Nr_p2={Nr_p2}, Na={Na}")

    # Pad fir + chirp to next power of 2 (real FFT IP is fixed-size)
    fir_padded = np.zeros((Na, Nr_p2), dtype=np.complex64)
    fir_padded[:, :Nr] = fir_coefficients
    chirp_padded = np.zeros(Nr_p2, dtype=np.complex64)
    chirp_padded[:Nr] = ref_chirp

    # Stage A: ADC-like fixed quantize. BRAM pre-scale for fir (per-frame
    # block scale factor); chirp is already O(1) so direct.
    fir_peak = float(np.maximum(np.abs(fir_padded.real).max(), np.abs(fir_padded.imag).max()))
    fir_pre_scale = 0.95 / fir_peak if fir_peak > 0 else 1.0
    fir_q   = quantize_fixed(fir_padded * fir_pre_scale, *Q_IN) / fir_pre_scale
    chirp_q = quantize_fixed(chirp_padded, *Q_IN)
    if verbose:
        print(f"  Stage A: fir_pre_scale=1/{1/fir_pre_scale:.3g}  fir_q.shape={fir_q.shape}  chirp_q.shape={chirp_q.shape}")

    # Stage B: FFT via Verilator, then per-scene power-of-2 shift (host-computed,
    # passed to the FPGA as a runtime parameter). Shifts collected for reporting.
    F, sh_ff = quantize_bfp(verilator_fft(fir_q),                   *Q_FFT, return_shift=True)
    C, sh_cf = quantize_bfp(verilator_fft(chirp_q.reshape(1, -1))[0], *Q_FFT, return_shift=True)
    prod, sh_pr = quantize_bfp(F * C[None, :], *Q_FFT, return_shift=True)

    # Stage C: IFFT via Verilator, per-scene power-of-2 shift for the final s_raw
    s_raw_padded, sh_o = quantize_bfp(verilator_ifft(prod), *Q_OUT, return_shift=True)
    shifts = {'fir_fft': sh_ff, 'chirp_fft': sh_cf, 'prod': sh_pr, 'out': sh_o}
    if verbose:
        print(f"  bit-shifts (host->FPGA params): {shifts}")

    # Crop zero-pad tail
    s_raw = s_raw_padded[:, :Nr].astype(np.complex64)
    if verbose:
        print(f"  s_raw={s_raw.shape}  peak|s|={float(np.abs(s_raw).max()):.3f}")
    return s_raw


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
