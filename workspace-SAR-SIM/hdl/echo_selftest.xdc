# =====================================================================
# ZCU111 on-hardware self-test constraints for echo_selftest_top.
#
# Clock source: user SI570 300 MHz differential board clock
#   (board interface default_sysclk1_300mhz, ports user_si570_sysclk_p/n).
#   The SI570 is free-running at its factory NVM default (300 MHz) at
#   power-up; no I2C bring-up needed for a functional test.
#   Pins (ZCU111 1.4 board file): J19 (P) / J18 (N), DIFF_SSTL12.
# clk_wiz_0 turns this 300 MHz into ~250 MHz aclk.
# =====================================================================

set_property PACKAGE_PIN J19 [get_ports user_si570_sysclk_p]
set_property PACKAGE_PIN J18 [get_ports user_si570_sysclk_n]
set_property IOSTANDARD DIFF_SSTL12 [get_ports user_si570_sysclk_p]
set_property IOSTANDARD DIFF_SSTL12 [get_ports user_si570_sysclk_n]

# 300 MHz input clock (3.333 ns)
create_clock -period 3.333 -name si570_clk [get_ports user_si570_sysclk_p]

