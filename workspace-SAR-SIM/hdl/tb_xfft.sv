// Testbench for xfft_0 (Xilinx FFT v9.1, pipelined streaming, BFP, truncation,
// runtime-NFFT, 16-bit). Streams a 1024-point complex frame from
// tmp/xfft_in.hex, captures the natural-order output, and dumps re/im codes +
// block exponent (tuser) to tmp/xfft_xsim_out.txt for host-side bit-exact
// comparison against the C-model (gen_xsim_vectors.py).
//
// Rules honoured (vivado-bridge anti-patterns / using_simulation):
//   - all declarations at module scope (xsim VRFC 10-8885)
//   - absolute forward-slash paths for $readmemh/$fwrite (cwd-independent)
//   - hard timeout + RESULT sentinel ($finish path guaranteed)
//   - unused m_axis_status master channel: tready tied 1'b1
`timescale 1ns / 1ps

module tb_xfft;

  // ---- parameters ----
  localparam integer N      = 1024;
  localparam [15:0]  CONFIG = 16'h010A;   // FWD_INV(bit8)=1 | NFFT[4:0]=10 (N=1024)
  localparam integer CLKP   = 10;         // 10 ns clock period

  // ---- clock ----
  reg aclk = 1'b0;
  always #(CLKP/2) aclk = ~aclk;

  // ---- config channel ----
  reg          s_axis_config_tvalid = 1'b0;
  reg  [15:0]  s_axis_config_tdata  = 16'h0000;
  wire         s_axis_config_tready;

  // ---- input data channel ----
  reg          s_axis_data_tvalid = 1'b0;
  reg  [31:0]  s_axis_data_tdata  = 32'h0;
  reg          s_axis_data_tlast  = 1'b0;
  wire         s_axis_data_tready;

  // ---- output data channel ----
  wire [31:0]  m_axis_data_tdata;
  wire [7:0]   m_axis_data_tuser;
  wire         m_axis_data_tvalid;
  wire         m_axis_data_tlast;
  reg          m_axis_data_tready = 1'b1;   // always ready to receive

  // ---- unused status master channel (tie tready high) ----
  wire [7:0]   m_axis_status_tdata;
  wire         m_axis_status_tvalid;
  wire         m_axis_status_tready = 1'b1;

  // ---- event outputs (observe only) ----
  wire event_frame_started;
  wire event_tlast_unexpected;
  wire event_tlast_missing;
  wire event_status_channel_halt;
  wire event_data_in_channel_halt;
  wire event_data_out_channel_halt;

  // ---- memories / counters (module scope) ----
  reg  [31:0] in_mem [0:N-1];
  integer     in_idx;
  integer     out_idx;
  integer     fout;
  integer     i;
  reg  [7:0]  last_blk_exp;
  reg         dump_done;

  // ---- DUT ----
  xfft_0 dut (
    .aclk                        (aclk),
    .s_axis_config_tdata         (s_axis_config_tdata),
    .s_axis_config_tvalid        (s_axis_config_tvalid),
    .s_axis_config_tready        (s_axis_config_tready),
    .s_axis_data_tdata           (s_axis_data_tdata),
    .s_axis_data_tvalid          (s_axis_data_tvalid),
    .s_axis_data_tready          (s_axis_data_tready),
    .s_axis_data_tlast           (s_axis_data_tlast),
    .m_axis_data_tdata           (m_axis_data_tdata),
    .m_axis_data_tuser           (m_axis_data_tuser),
    .m_axis_data_tvalid          (m_axis_data_tvalid),
    .m_axis_data_tready          (m_axis_data_tready),
    .m_axis_data_tlast           (m_axis_data_tlast),
    .m_axis_status_tdata         (m_axis_status_tdata),
    .m_axis_status_tvalid        (m_axis_status_tvalid),
    .m_axis_status_tready        (m_axis_status_tready),
    .event_frame_started         (event_frame_started),
    .event_tlast_unexpected      (event_tlast_unexpected),
    .event_tlast_missing         (event_tlast_missing),
    .event_status_channel_halt   (event_status_channel_halt),
    .event_data_in_channel_halt  (event_data_in_channel_halt),
    .event_data_out_channel_halt (event_data_out_channel_halt)
  );

  // ---- stimulus ----
  initial begin
    in_idx   = 0;
    out_idx  = 0;
    dump_done = 1'b0;
    last_blk_exp = 8'h00;

    for (i = 0; i < N; i = i + 1) in_mem[i] = 32'h0;
    $readmemh("d:/kamijo/HiyoCanvas/tmp/xfft_in.hex", in_mem);

    fout = $fopen("d:/kamijo/HiyoCanvas/tmp/xfft_xsim_out.txt", "w");
    if (fout == 0) begin
      $display("RESULT: FATAL could not open output file");
      $finish;
    end

    // let a few clocks elapse before configuring
    repeat (5) @(posedge aclk);

    // --- drive config (hold tvalid until accepted) ---
    @(negedge aclk);
    s_axis_config_tdata  = CONFIG;
    s_axis_config_tvalid = 1'b1;
    @(posedge aclk);
    while (s_axis_config_tready !== 1'b1) @(posedge aclk);
    // accepted on this edge
    @(negedge aclk);
    s_axis_config_tvalid = 1'b0;

    repeat (3) @(posedge aclk);

    // --- stream input samples respecting tready ---
    @(negedge aclk);
    s_axis_data_tvalid = 1'b1;
    s_axis_data_tdata  = in_mem[0];
    s_axis_data_tlast  = (N == 1) ? 1'b1 : 1'b0;
    in_idx = 0;
    while (in_idx < N) begin
      @(posedge aclk);
      if (s_axis_data_tvalid && s_axis_data_tready) begin
        in_idx = in_idx + 1;
        @(negedge aclk);
        if (in_idx < N) begin
          s_axis_data_tdata = in_mem[in_idx];
          s_axis_data_tlast = (in_idx == N-1) ? 1'b1 : 1'b0;
          s_axis_data_tvalid = 1'b1;
        end else begin
          s_axis_data_tvalid = 1'b0;
          s_axis_data_tlast  = 1'b0;
        end
      end
    end
    // input frame fully accepted; output capture handled by the always block.
  end

  // ---- output capture ----
  always @(posedge aclk) begin
    if (m_axis_data_tvalid && m_axis_data_tready && !dump_done) begin
      // re in low 16 bits, im in high 16 bits (both signed)
      $fwrite(fout, "%0d %0d %0d %0d\n",
              out_idx,
              $signed(m_axis_data_tdata[15:0]),
              $signed(m_axis_data_tdata[31:16]),
              m_axis_data_tuser);
      last_blk_exp = m_axis_data_tuser;
      out_idx = out_idx + 1;
      if (m_axis_data_tlast || out_idx == N) begin
        $fwrite(fout, "# blk_exp %0d\n", last_blk_exp);
        $fclose(fout);
        dump_done = 1'b1;
        $display("RESULT: captured %0d outputs, blk_exp=%0d, tlast=%0b",
                 out_idx, last_blk_exp, m_axis_data_tlast);
        $finish;
      end
    end
  end

  // ---- hard timeout safety ----
  initial begin
    #500_000;   // 500 us hard cap
    if (!dump_done) begin
      $fwrite(fout, "# blk_exp %0d\n", last_blk_exp);
      $fclose(fout);
      $display("RESULT: TIMEOUT after %0d outputs (in_idx=%0d)", out_idx, in_idx);
    end
    $finish;
  end

endmodule
