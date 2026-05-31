// STAGE 1 testbench: stream fir from tmp/echo_fir.hex through echo_stage1
// (xfft_fwd + coef ROM + cmpy), capture:
//   tmp/echo_stage1_F.txt : 'k Fre Fim be'  (FFT output codes, natural order)
//   tmp/echo_stage1_P.txt : 'k Pre Pim'     (cmpy 33-bit product, natural order)
// Both streams are naturally bin-ordered by their own valid-beat counters.
// Host compares P bit-exact to model_echo_datapath F*Hcoef (echo_P_expected).
//
// Rules: all decls at module scope; absolute fwd-slash paths; hard timeout +
// RESULT sentinel; FFT output is consumed (tready=1 inside DUT).
`timescale 1ns / 1ps

module tb_echo_stage1;

  localparam integer N      = 1024;
  localparam [15:0]  CONFIG = 16'h010A;     // FWD | NFFT=10
  localparam integer CLKP   = 10;

  reg aclk = 1'b0;
  always #(CLKP/2) aclk = ~aclk;

  // config channel
  reg          cfg_tvalid = 1'b0;
  reg  [15:0]  cfg_tdata  = 16'h0;
  wire         cfg_tready;

  // fir input channel
  reg          in_tvalid = 1'b0;
  reg  [31:0]  in_tdata  = 32'h0;
  reg          in_tlast  = 1'b0;
  wire         in_tready;

  // product output
  wire         prod_tvalid;
  wire [39:0]  prod_re;
  wire [39:0]  prod_im;
  wire [15:0]  dbg_F_re, dbg_F_im, dbg_H_re, dbg_H_im;
  wire [7:0]   dbg_be_fwd;

  // FFT-output observation: re-derive from DUT debug taps gated by an internal
  // FFT-valid. We tap the FFT output valid by observing in DUT via hierarchical
  // reference is fragile; instead capture F at the moment the ROM beat advances.
  // Simpler: capture F/H using a dedicated always on the DUT's fft output.

  reg  [31:0] in_mem [0:N-1];
  integer     in_idx;
  integer     p_idx;
  integer     f_idx;
  integer     fP, fF;
  integer     i;
  reg         done;

  echo_stage1 #(.N(N), .CONFIG_FWD(CONFIG)) dut (
    .aclk                 (aclk),
    .s_axis_data_tvalid   (in_tvalid),
    .s_axis_data_tdata    (in_tdata),
    .s_axis_data_tlast    (in_tlast),
    .s_axis_data_tready   (in_tready),
    .s_axis_config_tvalid (cfg_tvalid),
    .s_axis_config_tdata  (cfg_tdata),
    .s_axis_config_tready (cfg_tready),
    .prod_tvalid          (prod_tvalid),
    .prod_re              (prod_re),
    .prod_im              (prod_im),
    .dbg_F_re             (dbg_F_re),
    .dbg_F_im             (dbg_F_im),
    .dbg_H_re             (dbg_H_re),
    .dbg_H_im             (dbg_H_im),
    .dbg_be_fwd           (dbg_be_fwd)
  );

  // ---- stimulus ----
  initial begin
    in_idx = 0; p_idx = 0; f_idx = 0; done = 1'b0;
    for (i = 0; i < N; i = i + 1) in_mem[i] = 32'h0;
    $readmemh("d:/kamijo/HiyoCanvas/tmp/echo_fir.hex", in_mem);

    fP = $fopen("d:/kamijo/HiyoCanvas/tmp/echo_stage1_P.txt", "w");
    fF = $fopen("d:/kamijo/HiyoCanvas/tmp/echo_stage1_F.txt", "w");
    if (fP == 0 || fF == 0) begin
      $display("RESULT: FATAL could not open output files");
      $finish;
    end

    repeat (5) @(posedge aclk);

    // config
    @(negedge aclk);
    cfg_tdata = CONFIG; cfg_tvalid = 1'b1;
    @(posedge aclk);
    while (cfg_tready !== 1'b1) @(posedge aclk);
    @(negedge aclk);
    cfg_tvalid = 1'b0;

    repeat (3) @(posedge aclk);

    // stream fir
    @(negedge aclk);
    in_tvalid = 1'b1; in_tdata = in_mem[0]; in_tlast = (N==1);
    in_idx = 0;
    while (in_idx < N) begin
      @(posedge aclk);
      if (in_tvalid && in_tready) begin
        in_idx = in_idx + 1;
        @(negedge aclk);
        if (in_idx < N) begin
          in_tdata = in_mem[in_idx];
          in_tlast = (in_idx == N-1);
          in_tvalid = 1'b1;
        end else begin
          in_tvalid = 1'b0; in_tlast = 1'b0;
        end
      end
    end
  end

  // ---- capture FFT output codes (F) : gated by ROM-beat advance proxy ----
  // The DUT presents dbg_F/dbg_H combinationally for each FFT output beat. We
  // detect an FFT output beat by sampling when the DUT's internal fft m_tvalid
  // is high. Expose it via a hierarchical reference (xsim supports this in tb).
  always @(posedge aclk) begin
    if (dut.fwd_m_tvalid && dut.fwd_m_tready && (f_idx < N)) begin
      $fwrite(fF, "%0d %0d %0d %0d\n", f_idx,
              $signed(dbg_F_re), $signed(dbg_F_im), dbg_be_fwd);
      f_idx = f_idx + 1;
    end
  end

  // ---- capture cmpy product (P) ----
  always @(posedge aclk) begin
    if (prod_tvalid && (p_idx < N) && !done) begin
      $fwrite(fP, "%0d %0d %0d\n", p_idx, $signed(prod_re), $signed(prod_im));
      p_idx = p_idx + 1;
      if (p_idx == N) begin
        $fclose(fP);
        $fclose(fF);
        done = 1'b1;
        $display("RESULT: captured %0d products, %0d FFT outs, be_fwd=%0d",
                 p_idx, f_idx, dbg_be_fwd);
        $finish;
      end
    end
  end

  // ---- hard timeout ----
  initial begin
    #500_000;
    if (!done) begin
      $fclose(fP); $fclose(fF);
      $display("RESULT: TIMEOUT p_idx=%0d f_idx=%0d in_idx=%0d", p_idx, f_idx, in_idx);
    end
    $finish;
  end

endmodule
