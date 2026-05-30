"""
Python ctypes binding to the Xilinx FFT IP (xfft v9.1) bit-accurate C-model.

This wraps the prebuilt Windows nt64 DLL
(libIp_xfft_v9_1_bitacc_cmodel.dll, depends on libgmp.dll) so the exact
bit-level arithmetic of a Vivado FFT IP instance can be reproduced in Python.
No compiler is required: ctypes loads the prebuilt DLL directly.

The fixed generics below MUST match the Vivado IP instance "xfft_0":
    C_NFFT_MAX     = 16   (max transform length 2^16 = 65536)
    C_ARCH         = 3    (pipelined streaming)
    C_HAS_NFFT     = 1    (run-time configurable transform length)
    C_USE_FLT_PT   = 0    (fixed-point)
    C_INPUT_WIDTH  = 16   (Q1.15 input)
    C_TWIDDLE_WIDTH= 16
    C_HAS_SCALING  = 1
    C_HAS_BFP      = 1    (block floating point -> blk_exp output)
    C_HAS_ROUNDING = 0    (truncation)

Conventions established empirically by test_xfft_cmodel.py (see that file):
  * Block-floating-point recovery:  y_true = y_hw * 2 ** (+blk_exp)
    (the model scales the data DOWN by blk_exp bits and reports the shift, so
    multiply back UP by 2**(+blk_exp); verified SNR ~77 dB vs numpy, while the
    negative-sign candidate gives garbage).
  * IFFT normalization: the Xilinx inverse transform is UNSCALED (sum form),
    i.e. it equals numpy's  np.fft.ifft(x) * N  (no 1/N divide); the blk_exp
    again carries the BFP scaling, recovered with 2 ** (+blk_exp).
"""

from __future__ import annotations

import ctypes
import math
import os
import struct
from ctypes import POINTER, c_double, c_int, c_void_p
from pathlib import Path

import numpy as np

# --------------------------------------------------------------------------
# Fixed generics for THIS project (must match Vivado IP "xfft_0")
# --------------------------------------------------------------------------
GEN_C_NFFT_MAX = 16
GEN_C_ARCH = 3            # pipelined streaming
GEN_C_HAS_NFFT = 1
GEN_C_USE_FLT_PT = 0
GEN_C_INPUT_WIDTH = 16
GEN_C_TWIDDLE_WIDTH = 16
GEN_C_HAS_SCALING = 1
GEN_C_HAS_BFP = 1         # block floating point
GEN_C_HAS_ROUNDING = 0    # truncation

_CMODEL_DIR = Path(__file__).resolve().parent / "xfft_cmodel"


# --------------------------------------------------------------------------
# ctypes struct definitions (exact field order from the header)
# --------------------------------------------------------------------------
class XfftGenerics(ctypes.Structure):
    _fields_ = [
        ("C_NFFT_MAX", c_int),
        ("C_ARCH", c_int),
        ("C_HAS_NFFT", c_int),
        ("C_USE_FLT_PT", c_int),
        ("C_INPUT_WIDTH", c_int),
        ("C_TWIDDLE_WIDTH", c_int),
        ("C_HAS_SCALING", c_int),
        ("C_HAS_BFP", c_int),
        ("C_HAS_ROUNDING", c_int),
    ]


class XfftInputs(ctypes.Structure):
    _fields_ = [
        ("nfft", c_int),
        ("xn_re", POINTER(c_double)),
        ("xn_re_size", c_int),
        ("xn_im", POINTER(c_double)),
        ("xn_im_size", c_int),
        ("scaling_sch", POINTER(c_int)),
        ("scaling_sch_size", c_int),
        ("direction", c_int),
    ]


class XfftOutputs(ctypes.Structure):
    _fields_ = [
        ("xk_re", POINTER(c_double)),
        ("xk_re_size", c_int),
        ("xk_im", POINTER(c_double)),
        ("xk_im_size", c_int),
        ("blk_exp", c_int),
        ("overflow", c_int),
    ]


# --------------------------------------------------------------------------
# DLL loading
# --------------------------------------------------------------------------
_lib = None
_gmp = None


def _load_lib():
    """Load libgmp.dll then the xfft cmodel DLL. Cached per process."""
    global _lib, _gmp
    if _lib is not None:
        return _lib

    if struct.calcsize("P") != 8:
        raise RuntimeError(
            "xfft_cmodel requires 64-bit Python (the nt64 DLLs are 64-bit). "
            f"struct.calcsize('P')={struct.calcsize('P')}"
        )

    if not _CMODEL_DIR.is_dir():
        raise FileNotFoundError(
            f"C-model directory not found: {_CMODEL_DIR}\n"
            "Extract xfft_v9_1_bitacc_cmodel_nt64.zip there."
        )

    gmp_path = _CMODEL_DIR / "libgmp.dll"
    xfft_path = _CMODEL_DIR / "libIp_xfft_v9_1_bitacc_cmodel.dll"
    for p in (gmp_path, xfft_path):
        if not p.is_file():
            raise FileNotFoundError(f"Missing DLL: {p}")

    # Make the directory resolvable for dependent-DLL loading.
    os.add_dll_directory(str(_CMODEL_DIR))

    # GMP must be loaded first (the cmodel DLL depends on it).
    try:
        _gmp = ctypes.CDLL(str(gmp_path))
    except OSError as e:
        raise OSError(f"Failed to load libgmp.dll at {gmp_path}: {e}") from e
    try:
        lib = ctypes.CDLL(str(xfft_path))
    except OSError as e:
        raise OSError(
            f"Failed to load {xfft_path}: {e}\n"
            "(libgmp.dll loaded OK; this is the xfft cmodel DLL itself.)"
        ) from e

    # restype / argtypes for all 4 functions.
    lib.xilinx_ip_xfft_v9_1_get_default_generics.restype = XfftGenerics
    lib.xilinx_ip_xfft_v9_1_get_default_generics.argtypes = []

    lib.xilinx_ip_xfft_v9_1_create_state.restype = c_void_p
    lib.xilinx_ip_xfft_v9_1_create_state.argtypes = [XfftGenerics]  # by value

    lib.xilinx_ip_xfft_v9_1_destroy_state.restype = None
    lib.xilinx_ip_xfft_v9_1_destroy_state.argtypes = [c_void_p]

    lib.xilinx_ip_xfft_v9_1_bitacc_simulate.restype = c_int
    lib.xilinx_ip_xfft_v9_1_bitacc_simulate.argtypes = [
        c_void_p,
        XfftInputs,            # by value
        POINTER(XfftOutputs),  # by pointer
    ]

    _lib = lib
    return _lib


def _make_generics() -> XfftGenerics:
    return XfftGenerics(
        C_NFFT_MAX=GEN_C_NFFT_MAX,
        C_ARCH=GEN_C_ARCH,
        C_HAS_NFFT=GEN_C_HAS_NFFT,
        C_USE_FLT_PT=GEN_C_USE_FLT_PT,
        C_INPUT_WIDTH=GEN_C_INPUT_WIDTH,
        C_TWIDDLE_WIDTH=GEN_C_TWIDDLE_WIDTH,
        C_HAS_SCALING=GEN_C_HAS_SCALING,
        C_HAS_BFP=GEN_C_HAS_BFP,
        C_HAS_ROUNDING=GEN_C_HAS_ROUNDING,
    )


# --------------------------------------------------------------------------
# Cached state (one per process is fine for fixed generics)
# --------------------------------------------------------------------------
_state = None


def _get_state() -> c_void_p:
    global _state
    if _state is not None:
        return _state
    lib = _load_lib()
    gen = _make_generics()
    st = lib.xilinx_ip_xfft_v9_1_create_state(gen)
    if not st:
        raise RuntimeError("xilinx_ip_xfft_v9_1_create_state returned NULL")
    _state = st
    return _state


def destroy_state() -> None:
    """Destroy the cached C-model state (frees DLL-side memory)."""
    global _state
    if _state is not None:
        _load_lib().xilinx_ip_xfft_v9_1_destroy_state(_state)
        _state = None


# --------------------------------------------------------------------------
# Q1.15 pre-quantization (truncate toward zero, as the 16-bit datapath does)
# --------------------------------------------------------------------------
_Q15 = 32768.0
_Q15_MAX = 1.0 - 2.0 ** -15  # largest representable value < +1.0


def quantize_q15(x: np.ndarray) -> np.ndarray:
    """Pre-quantize a complex array to Q1.15: clip to [-1, 1-2^-15],
    truncate toward zero. Returns complex128."""
    x = np.asarray(x, dtype=np.complex128)
    re = np.clip(x.real, -1.0, _Q15_MAX)
    im = np.clip(x.imag, -1.0, _Q15_MAX)
    re = np.trunc(re * _Q15) / _Q15
    im = np.trunc(im * _Q15) / _Q15
    return re + 1j * im


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------
def xfft(x: np.ndarray, direction: int = 1) -> tuple[np.ndarray, int]:
    """Bit-accurate Vivado xfft v9.1 (pipelined, BFP, trunc, 16-bit) on a 1-D
    complex array of length N=2^nfft (8 <= N <= 65536). direction: 1=FFT, 0=IFFT.
    Returns (complex64 output, blk_exp). Input is pre-quantized to Q1.15 (the
    model requires -1<=re,im<1 pre-quantized to C_INPUT_WIDTH).

    NOTE: The returned array is the RAW BFP-normalized model output (matching
    the hardware bus). The true (numpy-scale) result is  out * 2**(+blk_exp).
    """
    lib = _load_lib()
    x = np.asarray(x).reshape(-1)
    N = x.shape[0]
    if N < 8 or N > 65536 or (N & (N - 1)) != 0:
        raise ValueError(f"N must be a power of 2 in [8, 65536]; got {N}")
    nfft = int(round(math.log2(N)))
    if direction not in (0, 1):
        raise ValueError("direction must be 1 (FFT) or 0 (IFFT)")

    xq = quantize_q15(x)
    xn_re = (c_double * N)(*xq.real.tolist())
    xn_im = (c_double * N)(*xq.imag.tolist())

    # Scaling schedule: S = ceil(nfft/2) for pipelined/radix-4.
    # Ignored in BFP mode but a valid array must be passed.
    S = (nfft + 1) // 2
    sched = (c_int * S)(*([0] * S))

    inp = XfftInputs(
        nfft=nfft,
        xn_re=ctypes.cast(xn_re, POINTER(c_double)),
        xn_re_size=N,
        xn_im=ctypes.cast(xn_im, POINTER(c_double)),
        xn_im_size=N,
        scaling_sch=ctypes.cast(sched, POINTER(c_int)),
        scaling_sch_size=S,
        direction=int(direction),
    )

    xk_re = (c_double * N)()
    xk_im = (c_double * N)()
    out = XfftOutputs(
        xk_re=ctypes.cast(xk_re, POINTER(c_double)),
        xk_re_size=N,
        xk_im=ctypes.cast(xk_im, POINTER(c_double)),
        xk_im_size=N,
        blk_exp=0,
        overflow=0,
    )

    st = _get_state()
    rc = lib.xilinx_ip_xfft_v9_1_bitacc_simulate(st, inp, ctypes.byref(out))
    if rc != 0:
        raise RuntimeError(f"xfft bitacc_simulate failed with code {rc}")

    re = np.frombuffer(xk_re, dtype=np.float64, count=N)
    im = np.frombuffer(xk_im, dtype=np.float64, count=N)
    y = (re + 1j * im).astype(np.complex64)
    return y, int(out.blk_exp)


def xfft_batch(X: np.ndarray, direction: int = 1) -> tuple[np.ndarray, np.ndarray]:
    """Run xfft() over each row of X (shape (Na, N)). The C-model is
    single-channel (one transform per call), so we loop.
    Returns (Y complex64 of shape (Na, N), blk_exp int array of shape (Na,))."""
    X = np.asarray(X)
    if X.ndim != 2:
        raise ValueError(f"X must be 2-D (Na, N); got shape {X.shape}")
    Na, N = X.shape
    Y = np.empty((Na, N), dtype=np.complex64)
    be = np.empty(Na, dtype=np.int32)
    for i in range(Na):
        Y[i], be[i] = xfft(X[i], direction)
    return Y, be
