// STAGE 2 testbench: full echo-synthesis datapath. Streams fir from
// tmp/echo_fir.hex, captures the xfft_inv output s_raw codes + be_inv (tuser)
// to tmp/echo_s_xsim_out.txt for host bit-exact comparison vs
// model_echo_datapath (tmp/echo_s_expected.txt).
//
// Rules: all decls at module scope; absolute fwd-slash paths; hard timeout +
// RESULT sentinel; unused status channels tied ready inside DUT.
`timescale 1ns / 1ps

module tb_echo_datapath;

  localparam integer N      = 1024;
  localparam integer NFFT   = 10;
  localparam integer SHIFT  = 14;
  localparam [15:0]  CFG_FWD = 16'h010A;   // FWD | NFFT=10
  localparam [15:0]  CFG_INV = 16'h000A;   // INV | NFFT=10
  localparam integer CLKP   = 10;

  reg aclk = 1'b0;
  always #(CLKP/2) aclk = ~aclk;

  reg          arst = 1'b1;

  // fwd config
  reg          cfg_tvalid = 1'b0;
  reg  [15:0]  cfg_tdata  = 16'h0;
  wire         cfg_tready;

  // fir input
  reg          in_tvalid = 1'b0;
  reg  [31:0]  in_tdata  = 32'h0;
  reg          in_tlast  = 1'b0;
  wire         in_tready;

  // s_raw output
  wire [31:0]  out_tdata;
  wire [7:0]   out_tuser;
  wire         out_tvalid;
  wire         out_tlast;
  reg          out_tready = 1'b1;
  wire [7:0]   dbg_be_fwd;

  reg  [31:0] in_mem [0:N-1];
  integer     in_idx;
  integer     out_idx;
  integer     fout;
  integer     i;
  reg  [7:0]  last_be_inv;
  reg         done;

  echo_datapath #(
    .N(N), .NFFT(NFFT), .SHIFT(SHIFT),
    .CONFIG_FWD(CFG_FWD), .CONFIG_INV(CFG_INV)
  ) dut (
    .aclk                 (aclk),
    .arst                 (arst),
    .s_axis_data_tvalid   (in_tvalid),
    .s_axis_data_tdata    (in_tdata),
    .s_axis_data_tlast    (in_tlast),
    .s_axis_data_tready   (in_tready),
    .s_axis_config_tvalid (cfg_tvalid),
    .s_axis_config_tdata  (cfg_tdata),
    .s_axis_config_tready (cfg_tready),
    .m_axis_data_tdata    (out_tdata),
    .m_axis_data_tuser    (out_tuser),
    .m_axis_data_tvalid   (out_tvalid),
    .m_axis_data_tlast    (out_tlast),
    .m_axis_data_tready   (out_tready),
    .dbg_be_fwd           (dbg_be_fwd)
  );

  // ---- stimulus ----
  initial begin
    in_idx = 0; out_idx = 0; done = 1'b0; last_be_inv = 8'h0;
    for (i = 0; i < N; i = i + 1) in_mem[i] = 32'h0;
    $readmemh("d:/kamijo/HiyoCanvas/tmp/echo_fir.hex", in_mem);

    fout = $fopen("d:/kamijo/HiyoCanvas/tmp/echo_s_xsim_out.txt", "w");
    if (fout == 0) begin
      $display("RESULT: FATAL could not open output file");
      $finish;
    end

    // hold reset a few cycles
    arst = 1'b1;
    repeat (5) @(posedge aclk);
    @(negedge aclk);
    arst = 1'b0;
    repeat (3) @(posedge aclk);

    // fwd config
    @(negedge aclk);
    cfg_tdata = CFG_FWD; cfg_tvalid = 1'b1;
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

  // ---- capture s_raw output ----
  always @(posedge aclk) begin
    if (out_tvalid && out_tready && !done) begin
      $fwrite(fout, "%0d %0d %0d %0d\n", out_idx,
              $signed(out_tdata[15:0]), $signed(out_tdata[31:16]), out_tuser);
      last_be_inv = out_tuser;
      out_idx = out_idx + 1;
      if (out_tlast || out_idx == N) begin
        $fwrite(fout, "# be_inv %0d\n", last_be_inv);
        $fclose(fout);
        done = 1'b1;
        $display("RESULT: captured %0d s_raw, be_inv=%0d, be_fwd=%0d, tlast=%0b",
                 out_idx, last_be_inv, dbg_be_fwd, out_tlast);
        $finish;
      end
    end
  end

  // ---- hard timeout ----
  initial begin
    #800_000;
    if (!done) begin
      $fwrite(fout, "# be_inv %0d\n", last_be_inv);
      $fclose(fout);
      $display("RESULT: TIMEOUT out_idx=%0d in_idx=%0d", out_idx, in_idx);
    end
    $finish;
  end

endmodule
