// Windows release 模式隐藏控制台窗口; debug 保留方便看日志
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pi_kitsune_desktop_lib::run()
}