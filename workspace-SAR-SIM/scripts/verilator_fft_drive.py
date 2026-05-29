"""Verilator-driven FFT runner — direct C++ testbench, no cocotb.

Workflow:
  1. Amaranth -> Verilog for chosen N
  2. Verilator --build (via MSYS2 bash) to compile testbench + DUT into .exe
  3. Pipe Q1.15 inputs to the .exe via stdin; collect Q(WG).15 outputs from stdout
  4. Compare with numpy.fft of the same quantized input
"""
import os
import sys
import subprocess
import shlex
import time
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))         # workspace-SAR-SIM/scripts
_WS = os.path.dirname(_HERE)                                # workspace-SAR-SIM
_ROOT = os.path.dirname(_WS)                                # project root
_BUILD_ROOT = os.path.join(_WS, "fpga_io")                  # gitignored
os.chdir(_ROOT)

# Tooling locations
BASH_EXE = r"C:\msys64\usr\bin\bash.exe"

def _to_msys(p):
    p = str(p)
    if len(p) >= 2 and p[1] == ':':
        return '/' + p[0].lower() + p[2:].replace('\\', '/')
    return p.replace('\\', '/')


def export_verilog(N: int) -> str:
    """Amaranth -> Verilog at the chosen N."""
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)
    from amaranth_seq_fft import SeqFFT
    from amaranth.back import verilog
    dut = SeqFFT(N=N, W_IN=16)
    ports = [
        dut.start, dut.done, dut.busy,
        dut.load_addr, dut.load_we,
        dut.load_data_re, dut.load_data_im,
        dut.read_data_re, dut.read_data_im,
    ]
    v_code = verilog.convert(dut, ports=ports, name=f"seq_fft_{N}")
    os.makedirs(_BUILD_ROOT, exist_ok=True)
    out = os.path.join(_BUILD_ROOT, f"seq_fft_{N}.v")
    with open(out, 'w') as f:
        f.write(v_code)
    print(f"[export] {out} ({len(v_code.splitlines())} lines)")
    return out


def verilate_build(N: int, verilog_path: str, build_dir: str):
    """Use Verilator via MSYS2 bash to compile the DUT + tb_seq_fft.cpp into an exe."""
    os.makedirs(build_dir, exist_ok=True)
    tb_cpp = os.path.join(_HERE, "tb_seq_fft.cpp")
    build_dir = os.path.abspath(build_dir)
    cmd = (
        f"verilator --cc --exe --build "
        f"--top-module seq_fft_{N} "
        f"--prefix Vtop "
        f"-Mdir {shlex.quote(_to_msys(build_dir))} "
        f"-Wno-fatal -Wno-WIDTH -Wno-UNOPTFLAT -Wno-MULTIDRIVEN -Wno-CASEINCOMPLETE -Wno-UNUSEDSIGNAL "
        f"-O3 -CFLAGS -O3 "
        f"-o tb_seq_fft "
        f"{shlex.quote(_to_msys(verilog_path))} "
        f"{shlex.quote(_to_msys(tb_cpp))}"
    )
    bash_cmd = [BASH_EXE, '-lc', cmd]
    print(f"[build] running verilator (via bash)")
    t0 = time.monotonic()
    res = subprocess.run(bash_cmd, capture_output=True)
    elapsed = time.monotonic() - t0
    out = res.stdout.decode('utf-8', errors='replace') if res.stdout else ''
    err = res.stderr.decode('utf-8', errors='replace') if res.stderr else ''
    if res.returncode != 0:
        sys.stderr.write(out)
        sys.stderr.write(err)
        raise SystemExit(f"verilator build failed (rc={res.returncode})")
    print(f"[build] done in {elapsed:.2f}s")
    exe = os.path.join(build_dir, "tb_seq_fft.exe")
    if not os.path.isfile(exe):
        # MSYS2 sometimes drops the .exe extension on the verilator-generated target
        alt = os.path.join(build_dir, "tb_seq_fft")
        if os.path.isfile(alt):
            return alt
        raise SystemExit(f"built exe not found in {build_dir}")
    return exe


Q15 = 1 << 15

def to_q15(x):
    return int(round(np.clip(x, -1.0, 1.0 - 1.0 / Q15) * Q15))


def _pack_int16_pairs(x_re: np.ndarray, x_im: np.ndarray) -> bytes:
    """Interleave real/imag arrays into int16 little-endian byte pairs."""
    re = np.asarray(x_re, dtype='<i2')
    im = np.asarray(x_im, dtype='<i2')
    out = np.empty(re.size + im.size, dtype='<i2')
    out[0::2] = re
    out[1::2] = im
    return out.tobytes()


def _unpack_int32_pairs(blob: bytes) -> np.ndarray:
    """De-interleave int32 byte stream back into a complex array (Q(WG).15 -> float)."""
    arr = np.frombuffer(blob, dtype='<i4')
    re = arr[0::2].astype(np.float64) / Q15
    im = arr[1::2].astype(np.float64) / Q15
    return re + 1j * im


def run_fft_exe(exe: str, N: int, x_re: np.ndarray, x_im: np.ndarray):
    """Pipe one frame through the FFT exe; return complex output."""
    buf = _pack_int16_pairs(np.asarray(x_re).reshape(-1), np.asarray(x_im).reshape(-1))

    env = os.environ.copy()
    env["FFT_N"] = str(N)
    t0 = time.monotonic()
    proc = subprocess.run([exe], input=buf, capture_output=True, env=env)
    elapsed = time.monotonic() - t0
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr.decode(errors='replace'))
        raise SystemExit(f"FFT exe failed (rc={proc.returncode})")

    out = proc.stdout
    if len(out) != N * 8:
        raise SystemExit(f"unexpected output size {len(out)}, expected {N*8}")
    hw = _unpack_int32_pairs(out)

    cycles_str = ""
    for line in proc.stderr.decode(errors='replace').splitlines():
        if "cycles_compute=" in line or "total_cycles=" in line:
            cycles_str = line.strip()
    return hw, elapsed, cycles_str


def run_fft_batch(exe: str, N: int, frames_re: np.ndarray, frames_im: np.ndarray):
    """Process Na frames in a single process invocation.

    frames_re, frames_im: shape (Na, N) int16-castable arrays of Q1.15 inputs.
    Returns: complex ndarray of shape (Na, N), elapsed seconds, tb stderr line.
    """
    Na, n = frames_re.shape
    if n != N:
        raise ValueError(f"frame width {n} != N ({N})")
    if frames_im.shape != frames_re.shape:
        raise ValueError("re/im shape mismatch")

    buf = _pack_int16_pairs(frames_re.reshape(-1), frames_im.reshape(-1))

    env = os.environ.copy()
    env["FFT_N"] = str(N)
    t0 = time.monotonic()
    proc = subprocess.run([exe], input=buf, capture_output=True, env=env)
    elapsed = time.monotonic() - t0
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr.decode(errors='replace'))
        raise SystemExit(f"FFT exe failed (rc={proc.returncode})")

    out = proc.stdout
    expected_bytes = Na * N * 8
    if len(out) != expected_bytes:
        raise SystemExit(f"unexpected output size {len(out)}, expected {expected_bytes}")
    hw_flat = _unpack_int32_pairs(out)
    hw = hw_flat.reshape(Na, N)

    info = ""
    for line in proc.stderr.decode(errors='replace').splitlines():
        if "frames=" in line:
            info = line.strip()
    return hw, elapsed, info


def benchmark(N: int):
    v = export_verilog(N)
    build_dir = os.path.join(_BUILD_ROOT, f"vbuild_{N}")
    exe = verilate_build(N, v, build_dir)
    # Random test vector
    rng = np.random.default_rng(0)
    x = (rng.standard_normal(N) + 1j * rng.standard_normal(N)) * 0.1
    x_re = np.array([to_q15(v.real) for v in x], dtype=np.int16)
    x_im = np.array([to_q15(v.imag) for v in x], dtype=np.int16)
    x_q15 = x_re.astype(np.float64) / Q15 + 1j * x_im.astype(np.float64) / Q15
    ref = np.fft.fft(x_q15)
    hw, elapsed, cycles_str = run_fft_exe(exe, N, x_re, x_im)
    err = np.abs(hw - ref)
    sig_rms = np.sqrt(np.mean(np.abs(ref) ** 2))
    err_rms = np.sqrt(np.mean(err ** 2))
    snr = 20 * np.log10(sig_rms / (err_rms + 1e-30))
    print(f"[result] N={N}  exec={elapsed*1000:.1f}ms  max|err|={err.max():.5g}  SNR={snr:.1f}dB  {cycles_str}")


if __name__ == "__main__":
    N = int(sys.argv[1]) if len(sys.argv) > 1 else 64
    benchmark(N)
