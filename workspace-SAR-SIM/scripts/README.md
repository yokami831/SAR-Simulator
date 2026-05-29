# SAR-SIM scripts — Amaranth FFT + Verilator HIL pipeline

Bit-exact gate-level reference implementation of the FPGA range-FFT for the
SAR simulator. Written in Amaranth (Python HDL), exported to Verilog, and
compiled to a native Windows executable with Verilator for ~50× faster
simulation than Amaranth's built-in pysim.

## Files

| File | Role |
|------|------|
| `amaranth_seq_fft.py` | `SeqFFT(N, W_IN)` — radix-2 DIT FFT, single butterfly, in-place RAM, log2(N) stages × N/2 butterflies × 3 cycles each. Q1.15 input, twiddle in Q1.15, internal Q(1+log2(N)).15. |
| `amaranth_fft8_poc.py` | Original PoC: 8-point fully-unrolled FFT, used to validate Amaranth+FFT correctness end-to-end against numpy.fft. |
| `tb_seq_fft.cpp` | Verilator C++ testbench. Reads N int16 complex pairs from stdin, drives the FFT, writes N int32 complex pairs to stdout. Pure binary I/O for Python interop. |
| `verilator_fft_drive.py` | Build + run driver. `export_verilog(N)` → `verilate_build(N)` → `run_fft_exe(N, in_re, in_im)`. CLI: `python verilator_fft_drive.py <N>` benchmarks against numpy. |

## Prerequisites

One-time setup on Windows:

```powershell
# 1. MSYS2 (via winget or installer)
winget install --id MSYS2.MSYS2

# 2. Verilator + GCC + make (via MSYS2's pacman)
C:\msys64\usr\bin\bash.exe -lc "pacman -Sy --noconfirm"
C:\msys64\usr\bin\bash.exe -lc "pacman -S --noconfirm mingw-w64-x86_64-verilator mingw-w64-x86_64-make mingw-w64-x86_64-gcc mingw-w64-x86_64-toolchain make"

# 3. Python deps (in the project .venv)
.venv\Scripts\python.exe -m pip install amaranth amaranth-yosys
```

Verify: `C:\msys64\mingw64\bin\verilator --version` should print Verilator 5.x.

## Quick benchmark

```powershell
.venv\Scripts\python.exe workspace-SAR-SIM\scripts\verilator_fft_drive.py 8192
```

Expected output:
```
[export] workspace-SAR-SIM\fpga_io\seq_fft_8192.v (...lines)
[build] done in ~20s     # one-time per N
[result] N=8192  exec=187ms  max|err|=0.18  SNR=68.2dB  cycles=159744
```

## HIL pipeline architecture

```
        Tab 1 (SAR-Simulator-FPGAx.rcflow, kernel namespace)
            │
            │  Route C-out writes coeffs.npz to workspace-SAR-SIM/fpga_io/
            ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Tab 2 (FPGA-HIL-Stub.rcflow)                              │
   │   Load .npz → FPGA Compute (cupy quantized OR Verilator) │
   │              → Save .npy                                   │
   └──────────────────────────────────────────────────────────┘
            │  fpga_out.npy
            ▼
        Tab 1 Route C-in loads → SLC image
```

The Verilator path is bit-exact to what real FPGA HDL synthesis would
produce — same Q-format, same arithmetic, same rounding. The cupy path is
faster (~0.1s/frame) but only Q-format-accurate, not gate-accurate. Use
cupy for iteration, Verilator for verification.

## Performance reference

| N | pysim | Verilator | speedup |
|---|-------|-----------|---------|
| 256 | 0.20 s | 281 ms | 0.7× (subprocess overhead dominates) |
| 1024 | 1.06 s | 172 ms | 6× |
| 4096 | 4.94 s | 187 ms | 26× |
| 8192 | 10.7 s | 187 ms | **57×** |

All measurements bit-exact (same SNR ~68 dB at Q1.15 twiddle precision).

## Path to real FPGA

This sequential single-butterfly design is for **simulation verification only**.
Cycle count for N=8192 is 159744 ≈ 1.6 ms @100 MHz, which is **6× too slow**
for the real-time SAR PRF budget (1/PRF = 250 μs). Real FPGA must use a
**pipelined streaming FFT** (1 sample/cycle throughput) — see e.g. Xilinx
FFT IP or ZipCPU dblclockfft. The Amaranth code here serves as a reference
to compare the pipelined implementation against.
