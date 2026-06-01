// RUNTIME-N testbench: drives echo_datapath_rt through three transform lengths
// (256, 1024, 4096) in ONE simulation, reconfiguring between them, and checks
// each captured s_raw frame BIT-EXACT against the model_echo_datapath expected
// vectors (per-N files from gen_echo_vectors_rt.py).
//
// For each N the TB:
//   1. pulses arst, loads the coeff BRAM via the write port from echo_coef_<N>.hex
//   2. sets nfft_sel/shift_sel, pulses frame_start (DUT (re)sends both xfft
//      config words for the new N)
//   3. streams N fir samples from echo_fir_<N>.hex (respecting tready)
//   4. captures N s_raw outputs + be_inv
//   5. compares to echo_s_expected_<N>.txt -> prints a per-N RESULT line
//
// Rules followed: all decls at module scope; absolute fwd-slash paths; control
// signals driven on negedge; hard timeout + RESULT sentinel; unused status
// channels tied ready inside the DUT; BRAMs zero-initialised in the DUT.
`timescale 1ns / 1ps

module tb_echo_datapath_rt;

  // ---- sizes under test (hard-coded; matches gen_echo_vectors_rt.N_LIST) ----
  localparam integer NUM_N = 3;
  localparam integer NMAX  = 4096;          // largest N exercised here
  localparam integer CLKP  = 10;

  reg aclk = 1'b0;
  always #(CLKP/2) aclk = ~aclk;

  reg          arst = 1'b1;

  // runtime selectors
  reg  [4:0]   nfft_sel  = 5'd0;
  reg  [5:0]   shift_sel = 6'd0;

  // coeff BRAM write port
  reg          coef_we    = 1'b0;
  reg  [15:0]  coef_waddr = 16'd0;
  reg  [31:0]  coef_wdata = 32'd0;

  // fir input
  reg          in_tvalid = 1'b0;
  reg  [31:0]  in_tdata  = 32'h0;
  reg          in_tlast  = 1'b0;
  wire         in_tready;

  // frame start
  reg          frame_start = 1'b0;

  // s_raw output
  wire [31:0]  out_tdata;
  wire [7:0]   out_tuser;
  wire         out_tvalid;
  wire         out_tlast;
  reg          out_tready = 1'b1;
  wire [7:0]   dbg_be_fwd;
  wire         dbg_fwd_cfg_tvalid;
  wire         dbg_fwd_cfg_tready;
  wire         dbg_inv_cfg_done;
  wire         dbg_pq_full;
  wire         dbg_fwd_m_tvalid;
  wire         dbg_fwd_m_tlast;
  wire         dbg_inv_cfg_tvalid;
  wire         dbg_inv_cfg_tready;
  wire [15:0]  dbg_inv_cfg_tdata;
  wire         dbg_inv_data_fire;
  wire         dbg_inv_data_tlast;
  integer      fwd_out_cnt;
  integer      inv_in_cnt;
  integer      raw_dump;

  // per-N data + expected
  reg  [31:0] in_mem    [0:NMAX-1];
  reg  [31:0] coef_mem  [0:NMAX-1];
  reg  [31:0] exp_re    [0:NMAX-1];   // expected Sre (sign-extended into 32b)
  reg  [31:0] exp_im    [0:NMAX-1];
  reg  [7:0]  exp_be_inv;

  // capture
  reg  [31:0] cap_re    [0:NMAX-1];
  reg  [31:0] cap_im    [0:NMAX-1];
  reg  [7:0]  cap_be_inv;

  // loop / bookkeeping
  integer ni;
  integer i;
  integer N;
  integer NFFT;
  integer SHIFT;
  integer in_idx;
  integer out_idx;
  integer mism;
  integer maxdiff;
  integer diff_re;
  integer diff_im;
  integer total_fail;
  integer ferr;
  reg     frame_active;     // capture window open for current N
  reg     frame_done;       // current N fully captured
  integer first_show;

  // sizes / params arrays (filled in initial)
  integer N_arr      [0:NUM_N-1];
  integer NFFT_arr   [0:NUM_N-1];
  integer SHIFT_arr  [0:NUM_N-1];

  // file path scratch
  reg [8*256-1:0] fir_path;
  reg [8*256-1:0] coef_path;
  reg [8*256-1:0] exp_path;

  echo_datapath_rt #(
    .NFFT_MAX(16), .NMAX(65536)
  ) dut (
    .aclk                 (aclk),
    .arst                 (arst),
    .nfft_sel             (nfft_sel),
    .shift_sel            (shift_sel),
    .coef_we              (coef_we),
    .coef_waddr           (coef_waddr),
    .coef_wdata           (coef_wdata),
    .s_axis_data_tvalid   (in_tvalid),
    .s_axis_data_tdata    (in_tdata),
    .s_axis_data_tlast    (in_tlast),
    .s_axis_data_tready   (in_tready),
    .frame_start          (frame_start),
    .m_axis_data_tdata    (out_tdata),
    .m_axis_data_tuser    (out_tuser),
    .m_axis_data_tvalid   (out_tvalid),
    .m_axis_data_tlast    (out_tlast),
    .m_axis_data_tready   (out_tready),
    .dbg_be_fwd           (dbg_be_fwd),
    .dbg_fwd_cfg_tvalid   (dbg_fwd_cfg_tvalid),
    .dbg_fwd_cfg_tready   (dbg_fwd_cfg_tready),
    .dbg_inv_cfg_done     (dbg_inv_cfg_done),
    .dbg_pq_full          (dbg_pq_full),
    .dbg_fwd_m_tvalid     (dbg_fwd_m_tvalid),
    .dbg_fwd_m_tlast      (dbg_fwd_m_tlast),
    .dbg_inv_cfg_tvalid   (dbg_inv_cfg_tvalid),
    .dbg_inv_cfg_tready   (dbg_inv_cfg_tready),
    .dbg_inv_cfg_tdata    (dbg_inv_cfg_tdata),
    .dbg_inv_data_fire    (dbg_inv_data_fire),
    .dbg_inv_data_tlast   (dbg_inv_data_tlast)
  );

  // ---- inverse-path monitors ----
  always @(posedge aclk) begin
    if (frame_active) begin
      if (dbg_inv_cfg_tvalid && dbg_inv_cfg_tready)
        $display("  CFG-INV-ACCEPT N=%0d tdata=0x%04h t=%0t", N, dbg_inv_cfg_tdata, $time);
      if (dbg_inv_data_fire) begin
        inv_in_cnt = inv_in_cnt + 1;
        if (dbg_inv_data_tlast)
          $display("  INV-DATA-TLAST N=%0d inv_in_cnt=%0d t=%0t", N, inv_in_cnt, $time);
      end
    end
  end

  // ---- diagnostics: count fwd-FFT output beats per frame; dump first 8
  //      s_raw output beats (raw, with tlast/be) per active frame ----
  always @(posedge aclk) begin
    if (frame_active) begin
      if (dbg_fwd_m_tvalid) fwd_out_cnt = fwd_out_cnt + 1;
      if (out_tvalid && out_tready && raw_dump < 8) begin
        $display("  RAW N=%0d beat=%0d re=%0d im=%0d be=%0d tlast=%0b",
                 N, out_idx, $signed(out_tdata[15:0]), $signed(out_tdata[31:16]),
                 out_tuser, out_tlast);
        raw_dump = raw_dump + 1;
      end
    end
  end

  // ---- log fwd config handshake completion ----
  always @(posedge aclk) begin
    if (dbg_fwd_cfg_tvalid && dbg_fwd_cfg_tready)
      $display("  CFG-FWD-ACCEPT N=%0d t=%0t", N, $time);
  end

  // =====================================================================
  // capture s_raw for the active frame
  // =====================================================================
  always @(posedge aclk) begin
    if (frame_active && !frame_done && out_tvalid && out_tready) begin
      cap_re[out_idx]  = $signed(out_tdata[15:0]);
      cap_im[out_idx]  = $signed(out_tdata[31:16]);
      cap_be_inv       = out_tuser;
      out_idx          = out_idx + 1;
      if (out_tlast || out_idx == N) begin
        frame_done = 1'b1;
      end
    end
  end

  // =====================================================================
  // main stimulus: loop over the three N
  // =====================================================================
  initial begin
    // sizes + params (must match gen_echo_vectors_rt.py manifest)
    N_arr[0]     = 256;  NFFT_arr[0] = 8;  SHIFT_arr[0] = 14;
    N_arr[1]     = 1024; NFFT_arr[1] = 10; SHIFT_arr[1] = 14;
    N_arr[2]     = 4096; NFFT_arr[2] = 12; SHIFT_arr[2] = 14;

    total_fail = 0;

    for (ni = 0; ni < NUM_N; ni = ni + 1) begin : per_n_loop
      N     = N_arr[ni];
      NFFT  = NFFT_arr[ni];
      SHIFT = SHIFT_arr[ni];

      // ---- build per-N file paths ----
      $sformat(fir_path,  "d:/kamijo/HiyoCanvas/tmp/echo_fir_%0d.hex",  N);
      $sformat(coef_path, "d:/kamijo/HiyoCanvas/tmp/echo_coef_%0d.hex", N);
      $sformat(exp_path,  "d:/kamijo/HiyoCanvas/tmp/echo_s_expected_%0d.txt", N);

      // ---- load fir + coeff + expected (host-side memory) ----
      for (i = 0; i < NMAX; i = i + 1) begin
        in_mem[i]   = 32'h0;
        coef_mem[i] = 32'h0;
        exp_re[i]   = 32'h0;
        exp_im[i]   = 32'h0;
      end
      $readmemh(fir_path,  in_mem);
      $readmemh(coef_path, coef_mem);
      load_expected(exp_path);

      // ---- reset the DUT between frames ----
      @(negedge aclk);
      arst        = 1'b1;
      in_tvalid   = 1'b0; in_tlast = 1'b0;
      frame_start = 1'b0;
      coef_we     = 1'b0;
      repeat (5) @(posedge aclk);
      @(negedge aclk);
      arst = 1'b0;
      repeat (3) @(posedge aclk);

      // ---- load coeff BRAM for this N via the write port ----
      @(negedge aclk);
      for (i = 0; i < N; i = i + 1) begin
        coef_we    = 1'b1;
        coef_waddr = i[15:0];
        coef_wdata = coef_mem[i];
        @(posedge aclk);
        @(negedge aclk);
      end
      coef_we = 1'b0;
      repeat (2) @(posedge aclk);

      // ---- set size/shift and pulse frame_start (sends both xfft configs) ----
      @(negedge aclk);
      nfft_sel  = NFFT[4:0];
      shift_sel = SHIFT[5:0];
      // open the capture window before output can appear
      out_idx      = 0;
      fwd_out_cnt  = 0;
      inv_in_cnt   = 0;
      raw_dump     = 0;
      frame_active = 1'b1;
      frame_done   = 1'b0;
      @(negedge aclk);
      frame_start = 1'b1;
      @(negedge aclk);
      frame_start = 1'b0;

      // give fwd config a few cycles to be accepted before streaming
      repeat (4) @(posedge aclk);

      // ---- stream fir (respect tready) ----
      @(negedge aclk);
      in_tvalid = 1'b1; in_tdata = in_mem[0]; in_tlast = (N == 1);
      in_idx = 0;
      while (in_idx < N) begin
        @(posedge aclk);
        if (in_tvalid && in_tready) begin
          in_idx = in_idx + 1;
          @(negedge aclk);
          if (in_idx < N) begin
            in_tdata  = in_mem[in_idx];
            in_tlast  = (in_idx == N-1);
            in_tvalid = 1'b1;
          end else begin
            in_tvalid = 1'b0; in_tlast = 1'b0;
          end
        end
      end
      in_tvalid = 1'b0; in_tlast = 1'b0;

      // ---- wait for the frame to be captured ----
      while (!frame_done) @(posedge aclk);
      frame_active = 1'b0;
      @(negedge aclk);

      // ---- compare bit-exact ----
      mism    = 0;
      maxdiff = 0;
      first_show = 0;
      for (i = 0; i < N; i = i + 1) begin : cmp_loop
        diff_re = cap_re[i] - $signed(exp_re[i]);
        diff_im = cap_im[i] - $signed(exp_im[i]);
        if (diff_re < 0) diff_re = -diff_re;
        if (diff_im < 0) diff_im = -diff_im;
        if (diff_re != 0 || diff_im != 0) begin
          mism = mism + 1;
          if (diff_re > maxdiff) maxdiff = diff_re;
          if (diff_im > maxdiff) maxdiff = diff_im;
          if (first_show < 5) begin
            $display("  MISMATCH N=%0d idx=%0d rtl=(%0d,%0d) exp=(%0d,%0d)",
                     N, i, cap_re[i], cap_im[i],
                     $signed(exp_re[i]), $signed(exp_im[i]));
            first_show = first_show + 1;
          end
        end
      end

      if (mism != 0) total_fail = total_fail + 1;
      if (cap_be_inv !== exp_be_inv) total_fail = total_fail + 1;

      $display("RESULT N=%0d: cfg_fwd=0x%03h cfg_inv=0x%03h samples=%0d fwd_beats=%0d exact=%0d/%0d maxdiff=%0d be_inv rtl=%0d model=%0d %s",
               N, (16'h100 | NFFT), NFFT[15:0], out_idx, fwd_out_cnt, (N - mism), N, maxdiff,
               cap_be_inv, exp_be_inv,
               ((mism == 0 && cap_be_inv === exp_be_inv) ? "PASS" : "FAIL"));
    end

    if (total_fail == 0)
      $display("RESULT: ALL PASS (%0d sizes bit-exact)", NUM_N);
    else
      $display("RESULT: FAIL (%0d size/be checks failed)", total_fail);
    $finish;
  end

  // =====================================================================
  // load expected s_raw vector (k Sre Sim ... + '# be_inv N')
  // =====================================================================
  task load_expected(input [8*256-1:0] path);
    integer fd;
    integer code;
    integer kk;
    integer sre;
    integer sim_;
    integer beval;
    reg [8*512-1:0] line;
    begin
      exp_be_inv = 8'h0;
      fd = $fopen(path, "r");
      if (fd == 0) begin
        $display("RESULT: FATAL cannot open %0s", path);
        $finish;
      end
      // read line by line: data lines are "k Sre Sim"; the footer line is
      // "# be_inv N".  Parse each line robustly with $sscanf.
      while ($fgets(line, fd) != 0) begin
        // try "# be_inv N" first (footer)
        if ($sscanf(line, "# be_inv %d", beval) == 1) begin
          exp_be_inv = beval[7:0];
        end else begin
          code = $sscanf(line, "%d %d %d", kk, sre, sim_);
          if (code == 3) begin
            exp_re[kk] = sre;
            exp_im[kk] = sim_;
          end
        end
      end
      $fclose(fd);
    end
  endtask

  // =====================================================================
  // hard timeout
  // =====================================================================
  initial begin
    #2_000_000;     // 2 ms safety cap (covers 3 frames incl. coeff loads + FFT latency)
    $display("RESULT: TIMEOUT ni=%0d N=%0d in_idx=%0d out_idx=%0d frame_done=%0b",
             ni, N, in_idx, out_idx, frame_done);
    $finish;
  end

endmodule
