"""
PoC: 8-point complex FFT in Amaranth (combinational, fully unrolled).

Goal: prove that we can build a numerically correct FFT in Amaranth and
match numpy.fft.fft to within Q1.15 quantization noise. Once this works,
we extend to larger N (sequential, with state machine).

Format:
- Input  : 8 complex samples, each Q1.15 (signed 16-bit real, signed 16-bit imag)
           Value range [-1, +1)
- Twiddle: Q1.15
- Internal datapath grows to ~Q4.15 (4 bits headroom for the 3 FFT stages)
- Output : Q4.15 (20-bit signed real, 20-bit signed imag)

Architecture: DIT radix-2, fully combinational, all 12 butterflies unrolled.
This is the simplest possible Amaranth FFT — proves it works, but scales
poorly. Real implementation will use a sequential butterfly.
"""
import numpy as np
from amaranth import Module, Signal, Elaboratable, signed
from amaranth.sim import Simulator
from amaranth.hdl import Const

# ---------- Q-format helpers ----------
W_IN  = 16          # Q1.15
W_OUT = 20          # Q4.15  (3 bits stage growth + 1 headroom)
Q15   = 1 << 15     # 2^15 = 32768 = scale factor for Q1.15

def to_q15(x):
    """Convert float in [-1, 1) to Q1.15 signed int."""
    return int(round(np.clip(x, -1.0, 1.0 - 1.0 / Q15) * Q15))

def from_q4_15(x, W=W_OUT):
    """Convert Q4.15 signed int back to float."""
    return x / Q15

# Twiddle factors W_8^k = exp(-j 2π k / 8), Q1.15
_C = to_q15(np.cos(np.pi / 4))    # 0.7071 -> 23170
TWID = {
    0: (Q15 - 1,  0),              # ~ 1 + 0j (0.99997 to avoid +1 overflow)
    1: ( _C, -_C),                 # 0.7071 - 0.7071 j
    2: ( 0,  -(Q15 - 1)),          # 0 - 1 j
    3: (-_C, -_C),                 # -0.7071 - 0.7071 j
}


class FFT8(Elaboratable):
    """8-point complex DIT FFT, combinational. All Q1.15 input, Q4.15 output."""

    def __init__(self):
        self.in_re  = [Signal(signed(W_IN),  name=f"in_re_{i}")  for i in range(8)]
        self.in_im  = [Signal(signed(W_IN),  name=f"in_im_{i}")  for i in range(8)]
        self.out_re = [Signal(signed(W_OUT), name=f"out_re_{i}") for i in range(8)]
        self.out_im = [Signal(signed(W_OUT), name=f"out_im_{i}") for i in range(8)]

    def _butterfly(self, m, a_re, a_im, b_re, b_im, k):
        """Compute (a + W^k * b, a - W^k * b). Returns 4 Signals of signed(W).

        W is wide enough to absorb the multiply (Q1.15 * Q1.15 = Q2.30) and
        the add/sub. Output is shifted right by 15 (back to Q1.15-aligned).
        """
        wr, wi = TWID[k]
        # complex multiply: (br + j bi)(wr + j wi) = (br*wr - bi*wi) + j(br*wi + bi*wr)
        wb_re = Signal(signed(33))   # Q2.30
        wb_im = Signal(signed(33))
        m.d.comb += [
            wb_re.eq(b_re * wr - b_im * wi),
            wb_im.eq(b_re * wi + b_im * wr),
        ]
        # shift back to Q1.15-aligned, then add/sub with a (which is already Q_x.15)
        out_a_re = Signal(signed(W_OUT))
        out_a_im = Signal(signed(W_OUT))
        out_b_re = Signal(signed(W_OUT))
        out_b_im = Signal(signed(W_OUT))
        m.d.comb += [
            out_a_re.eq(a_re + (wb_re >> 15)),
            out_a_im.eq(a_im + (wb_im >> 15)),
            out_b_re.eq(a_re - (wb_re >> 15)),
            out_b_im.eq(a_im - (wb_im >> 15)),
        ]
        return out_a_re, out_a_im, out_b_re, out_b_im

    def elaborate(self, platform):
        m = Module()

        # Bit-reverse input ordering (DIT)
        BR = [0, 4, 2, 6, 1, 5, 3, 7]
        s0_re = [self.in_re[BR[i]] for i in range(8)]
        s0_im = [self.in_im[BR[i]] for i in range(8)]

        # Stage 1: 4 butterflies, all with W_8^0 (= 1)
        s1 = []
        for i in range(0, 8, 2):
            a_re, a_im, b_re, b_im = self._butterfly(
                m, s0_re[i], s0_im[i], s0_re[i+1], s0_im[i+1], k=0)
            s1.append((a_re, a_im))
            s1.append((b_re, b_im))

        # Stage 2: 2 groups of 2 butterflies; ks = [0, 2, 0, 2]
        s2 = []
        for grp in range(2):
            for j in range(2):
                idx_a = grp * 4 + j
                idx_b = grp * 4 + j + 2
                k = 0 if j == 0 else 2
                a_re, a_im, b_re, b_im = self._butterfly(
                    m, s1[idx_a][0], s1[idx_a][1], s1[idx_b][0], s1[idx_b][1], k=k)
                s2.append((idx_a, a_re, a_im))
                s2.append((idx_b, b_re, b_im))
        # reorder s2 by idx
        s2_sorted = sorted(s2, key=lambda t: t[0])
        s2_re = [t[1] for t in s2_sorted]
        s2_im = [t[2] for t in s2_sorted]

        # Stage 3: 4 butterflies; ks = [0, 1, 2, 3]
        for j in range(4):
            idx_a = j
            idx_b = j + 4
            k = j
            a_re, a_im, b_re, b_im = self._butterfly(
                m, s2_re[idx_a], s2_im[idx_a], s2_re[idx_b], s2_im[idx_b], k=k)
            m.d.comb += [
                self.out_re[idx_a].eq(a_re),
                self.out_im[idx_a].eq(a_im),
                self.out_re[idx_b].eq(b_re),
                self.out_im[idx_b].eq(b_im),
            ]
        return m


# =====================================================================
# Verification: drive a test vector, compare with numpy.fft.fft
# =====================================================================

def run_test():
    rng = np.random.default_rng(0)
    # Test vector: random complex in [-0.5, 0.5] to leave headroom
    x = (rng.standard_normal(8) + 1j * rng.standard_normal(8)) * 0.2
    x = x.astype(np.complex64)

    # Quantize to Q1.15 (what the hardware sees)
    x_q = (np.round(x.real * Q15) + 1j * np.round(x.imag * Q15)) / Q15

    # Numpy reference (with quantized input)
    ref = np.fft.fft(x_q.astype(np.complex64))

    # Amaranth simulation
    dut = FFT8()
    sim = Simulator(dut)

    captured = {'re': [0]*8, 'im': [0]*8}

    async def tb(ctx):
        # Drive inputs
        for i in range(8):
            ctx.set(dut.in_re[i], to_q15(x[i].real))
            ctx.set(dut.in_im[i], to_q15(x[i].imag))
        # Combinational -> let signals settle (delta cycle)
        await ctx.delay(0)
        # Capture outputs
        for i in range(8):
            captured['re'][i] = ctx.get(dut.out_re[i])
            captured['im'][i] = ctx.get(dut.out_im[i])

    sim.add_testbench(tb)
    sim.run()

    # Convert captured Q4.15 ints back to float
    hw = np.array([captured['re'][i] / Q15 + 1j * captured['im'][i] / Q15 for i in range(8)])

    print('Input (Q1.15 quantized):')
    for i, v in enumerate(x_q):
        print(f'  x[{i}] = {v.real:+.5f} {v.imag:+.5f}j')

    print('\nReference numpy.fft (with quantized input):')
    for i, v in enumerate(ref):
        print(f'  X[{i}] = {v.real:+.5f} {v.imag:+.5f}j')

    print('\nAmaranth hardware FFT output:')
    for i, v in enumerate(hw):
        print(f'  X[{i}] = {v.real:+.5f} {v.imag:+.5f}j')

    err = np.abs(hw - ref)
    print(f'\nmax abs err: {err.max():.5g}')
    print(f'rms err    : {np.sqrt(np.mean(err**2)):.5g}')
    print(f'rms signal : {np.sqrt(np.mean(np.abs(ref)**2)):.5g}')
    snr = 20 * np.log10(np.sqrt(np.mean(np.abs(ref)**2)) / (np.sqrt(np.mean(err**2)) + 1e-30))
    print(f'SNR        : {snr:.1f} dB')


if __name__ == '__main__':
    run_test()
