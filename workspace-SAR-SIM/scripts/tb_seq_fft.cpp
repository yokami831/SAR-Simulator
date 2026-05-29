// Verilator C++ testbench for SeqFFT.
// Protocol (stdin → DUT → stdout, all binary):
//   For each frame:
//     stdin : N pairs of (re:int16_le, im:int16_le)  -- Q1.15 inputs
//     stdout: N pairs of (re:int32_le, im:int32_le)  -- Q(WG).15 outputs
//   Loops until stdin EOF, so a single process can handle many frames
//   back-to-back (amortizes the ~150ms process startup cost over a full
//   SAR azimuth sweep of 2016 rows).
// Bit-reverse on input is done in this testbench (matches the FFT's expected
// DIT input ordering).
#include <verilated.h>
#include <cstdio>
#include <cstdint>
#include <vector>
#include <cstring>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

// Verilator generates Vtop.h via --prefix Vtop
#include "Vtop.h"

// Required by Verilator's verilated.cpp (used for $time / VCD timestamps; we
// don't dump waves so 0 is fine).
double sc_time_stamp() { return 0; }

static int log2_int(int n) {
    int k = 0;
    while ((1 << k) < n) ++k;
    return k;
}

static int bitrev(int i, int log_n) {
    int r = 0;
    for (int k = 0; k < log_n; ++k) {
        if (i & (1 << k)) r |= 1 << (log_n - 1 - k);
    }
    return r;
}

static void tick(Vtop* dut) {
    dut->clk = 0; dut->eval();
    dut->clk = 1; dut->eval();
}

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);

#ifdef _WIN32
    // Ensure no CR/LF translation on stdin/stdout — pure binary IO.
    _setmode(_fileno(stdin),  _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    // FFT_N must match the Amaranth export
    const int N = std::atoi(std::getenv("FFT_N") ? std::getenv("FFT_N") : "64");
    const int LOG_N = log2_int(N);
    const int WG = 16 + LOG_N;
    const uint32_t signbit = 1u << (WG - 1);
    const uint32_t mask = (WG == 32) ? 0xFFFFFFFFu : ((1u << WG) - 1u);

    Vtop* dut = new Vtop;

    // One-time reset on startup
    dut->rst = 1; dut->start = 0; dut->load_we = 0;
    dut->load_addr = 0; dut->load_data_re = 0; dut->load_data_im = 0;
    for (int i = 0; i < 8; ++i) tick(dut);
    dut->rst = 0;
    tick(dut); tick(dut);

    std::vector<int16_t> in_re(N), in_im(N);
    int frame_count = 0;
    long long total_cycles = 0;

    while (true) {
        // Try to read one frame's worth of input
        size_t got_re = 0, got_im = 0;
        for (int i = 0; i < N; ++i) {
            int16_t v;
            if (std::fread(&v, 2, 1, stdin) != 1) { got_re = i; goto eof_check; }
            in_re[i] = v;
            if (std::fread(&v, 2, 1, stdin) != 1) { got_im = i; got_re = N; goto eof_check; }
            in_im[i] = v;
        }
        got_re = N; got_im = N;

      eof_check:
        if (got_re == 0 && got_im == 0) {
            // Clean EOF before any byte of a new frame -- normal termination
            break;
        }
        if (got_re != N || got_im != N) {
            std::fprintf(stderr, "[tb] partial frame at frame=%d: got_re=%zu got_im=%zu (expected %d)\n",
                         frame_count, got_re, got_im, N);
            delete dut; return 2;
        }

        // Pre-load RAM at bit-reversed addresses
        for (int i = 0; i < N; ++i) {
            int br = bitrev(i, LOG_N);
            dut->load_addr = br;
            dut->load_data_re = (uint32_t)(int32_t)in_re[i];
            dut->load_data_im = (uint32_t)(int32_t)in_im[i];
            dut->load_we = 1;
            tick(dut);
        }
        dut->load_we = 0;
        tick(dut); tick(dut);

        // Start FFT
        dut->start = 1; tick(dut); dut->start = 0;

        // Wait for done
        int max_cycles = 4 * (N / 2) * LOG_N + 200;
        int waited = 0;
        while (true) {
            tick(dut); ++waited;
            if (!dut->busy) break;
            if (waited > max_cycles) {
                std::fprintf(stderr, "[tb] frame=%d FFT didn't finish in %d cycles\n", frame_count, max_cycles);
                delete dut; return 3;
            }
        }
        total_cycles += waited;

        // Drain output (natural order)
        for (int i = 0; i < N; ++i) {
            dut->load_addr = i;
            tick(dut); tick(dut); // 1-cycle read latency + 1 settle
            uint32_t re_u = (uint32_t)dut->read_data_re & mask;
            uint32_t im_u = (uint32_t)dut->read_data_im & mask;
            int32_t re = (re_u & signbit) ? (int32_t)(re_u | ~mask) : (int32_t)re_u;
            int32_t im = (im_u & signbit) ? (int32_t)(im_u | ~mask) : (int32_t)im_u;
            std::fwrite(&re, 4, 1, stdout);
            std::fwrite(&im, 4, 1, stdout);
        }
        std::fflush(stdout);
        ++frame_count;
    }

    std::fprintf(stderr, "[tb] N=%d frames=%d total_cycles=%lld\n", N, frame_count, total_cycles);
    delete dut;
    return 0;
}
