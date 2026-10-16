// 桌宠舞台线程: 动态点击穿透
//
// 桌宠窗口是一张比角色大的透明画布 (要给气泡、跳跃留位置), 透明区域不能挡住身后的窗口。
// 做法: 窗口默认穿透, 鼠标进到角色包围盒时才关掉穿透。
// 判定必须放在 Rust 侧轮询全局鼠标 —— 穿透打开后 WebView 收不到任何 mousemove,
// 前端没法自己知道鼠标"回来了"。
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// 角色包围盒, 相对窗口左上角的逻辑像素 (前端按画布布局算好上报)
#[derive(Clone, Copy, serde::Deserialize)]
pub struct HitBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

static HITBOX: OnceLock<Mutex<Option<HitBox>>> = OnceLock::new();
static DRAGGING: AtomicBool = AtomicBool::new(false);
/// 线程代际: 每次开窗 +1, 旧线程发现代际变了就退出。
/// 关窗后立刻重开时, 旧线程可能还没察觉窗口没了, 不靠代际会出现两个线程抢着切穿透
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn hitbox() -> &'static Mutex<Option<HitBox>> {
    HITBOX.get_or_init(|| Mutex::new(None))
}

/// 鼠标在宠物窗口附近时的轮询间隔; 离得远就放慢 —— 它总得先移过来才可能点到宠物
const TICK_NEAR: Duration = Duration::from_millis(33);
const TICK_FAR: Duration = Duration::from_millis(100);
/// "附近"= 窗口矩形外扩这么多物理像素。慢速档 100ms 里鼠标走不了太远, 外扩一圈保证
/// 鼠标进到角色之前已经切回快速档, 不会出现"指上去要等一下才能点"
const NEAR_MARGIN: f64 = 200.0;
/// 缩放比只在窗口跨显示器时才变, 每轮都问的话要排队到主线程, 一秒刷新一次足够
const SCALE_REFRESH: Duration = Duration::from_secs(1);

/// 一次采样: 全局鼠标位置 + 窗口外框, 都是物理像素
struct Probe {
    cx: f64,
    cy: f64,
    wx: f64,
    wy: f64,
    ww: f64,
    wh: f64,
}

/// 开窗后调用: 起一条舞台线程, 窗口销毁或被新一代取代时自行退出
pub fn start(app: tauri::AppHandle) {
    let gen = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut h) = hitbox().lock() {
        *h = None;
    }
    DRAGGING.store(false, Ordering::SeqCst);

    std::thread::spawn(move || {
        let Some(win) = app.get_webview_window("pet") else {
            return;
        };
        // 窗口句柄在窗口存活期间不变, 取一次缓存住 (每次取都要排队到主线程)
        #[cfg(windows)]
        let Ok(hwnd) = win.hwnd().map(|h| h.0 as isize) else {
            return;
        };
        let mut scale = win.scale_factor().unwrap_or(1.0);
        let mut scale_at = Instant::now();
        // None = 还没设置过, 保证第一轮一定下发一次穿透状态
        let mut last_ignore: Option<bool> = None;
        #[cfg(debug_assertions)]
        let (mut cost_sum, mut cost_n, mut report_at) = (Duration::ZERO, 0u32, Instant::now());

        loop {
            if GENERATION.load(Ordering::SeqCst) != gen {
                break;
            }
            let Some(win) = app.get_webview_window("pet") else {
                break;
            };
            let started = Instant::now();

            // 拖动结束由这里判定: 系统拖拽的模态移动循环会吞掉松手消息 (tao 只给原生窗口补发
            // WM_LBUTTONUP, WebView 里的页面收不到 mouseup), 前端没法自己知道拖完了
            if DRAGGING.load(Ordering::SeqCst) && !primary_button_down() {
                DRAGGING.store(false, Ordering::SeqCst);
                let _ = app.emit_to("pet", "pet_stage", serde_json::json!({ "kind": "dragEnd" }));
            }

            if scale_at.elapsed() >= SCALE_REFRESH {
                if let Ok(s) = win.scale_factor() {
                    scale = s;
                }
                scale_at = Instant::now();
            }

            #[cfg(windows)]
            let probe = probe_win32(hwnd);
            #[cfg(not(windows))]
            let probe = probe_tauri(&app, &win);

            let dragging = DRAGGING.load(Ordering::SeqCst);
            // 采样失败按"不在"处理 —— 宁可一时点不到宠物, 也不能让整张透明画布挡住用户
            let (inside, near) = match &probe {
                Some(p) => (cursor_in_hitbox(p, scale), cursor_near_window(p)),
                None => (false, false),
            };
            let ignore = !(dragging || inside);
            if last_ignore != Some(ignore) {
                // 失败 (窗口正在销毁) 不记状态, 下一轮重试或随窗口消失退出
                if win.set_ignore_cursor_events(ignore).is_ok() {
                    last_ignore = Some(ignore);
                }
            }

            #[cfg(debug_assertions)]
            {
                cost_sum += started.elapsed();
                cost_n += 1;
                if report_at.elapsed() >= Duration::from_secs(5) {
                    eprintln!(
                        "[pet_stage] 每轮耗时均值 {:?} ({} 轮), 当前穿透={}",
                        cost_sum / cost_n.max(1),
                        cost_n,
                        ignore
                    );
                    cost_sum = Duration::ZERO;
                    cost_n = 0;
                    report_at = Instant::now();
                }
            }

            let tick = if dragging || near { TICK_NEAR } else { TICK_FAR };
            std::thread::sleep(tick.saturating_sub(started.elapsed()));
        }
    });
}

/// Windows 直接读系统 API: 不经过 Tauri 窗口接口, 免得每轮都排队到主线程
#[cfg(windows)]
fn probe_win32(hwnd: isize) -> Option<Probe> {
    use windows_sys::Win32::Foundation::{POINT, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect};
    let mut pt = POINT { x: 0, y: 0 };
    let mut rc = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    // Tauri 应用按 per-monitor DPI 感知运行, 两者拿到的都是物理像素
    let ok = unsafe { GetCursorPos(&mut pt) != 0 && GetWindowRect(hwnd as _, &mut rc) != 0 };
    ok.then(|| Probe {
        cx: pt.x as f64,
        cy: pt.y as f64,
        wx: rc.left as f64,
        wy: rc.top as f64,
        ww: (rc.right - rc.left) as f64,
        wh: (rc.bottom - rc.top) as f64,
    })
}

#[cfg(not(windows))]
fn probe_tauri(app: &tauri::AppHandle, win: &tauri::WebviewWindow) -> Option<Probe> {
    let cursor = app.cursor_position().ok()?;
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    Some(Probe {
        cx: cursor.x,
        cy: cursor.y,
        wx: pos.x as f64,
        wy: pos.y as f64,
        ww: size.width as f64,
        wh: size.height as f64,
    })
}

fn cursor_in_hitbox(p: &Probe, scale: f64) -> bool {
    let Some(hb) = hitbox().lock().ok().and_then(|h| *h) else {
        return false;
    };
    // 采样是物理像素, 包围盒是逻辑像素
    let rx = (p.cx - p.wx) / scale;
    let ry = (p.cy - p.wy) / scale;
    rx >= hb.x && rx < hb.x + hb.w && ry >= hb.y && ry < hb.y + hb.h
}

fn cursor_near_window(p: &Probe) -> bool {
    p.cx >= p.wx - NEAR_MARGIN
        && p.cx < p.wx + p.ww + NEAR_MARGIN
        && p.cy >= p.wy - NEAR_MARGIN
        && p.cy < p.wy + p.wh + NEAR_MARGIN
}

/// 主键 (通常是左键) 当前是否按着。左右键对调的用户主键是物理右键, 拖动用的也是它
#[cfg(windows)]
fn primary_button_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};
    unsafe {
        let vk = if GetSystemMetrics(SM_SWAPBUTTON) != 0 { VK_RBUTTON } else { VK_LBUTTON };
        // 最高位为 1 表示此刻按下
        (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0
    }
}

/// 非 Windows 平台读不到全局键状态, 一律视为按着, 拖动结束交给前端 mouseup 兜底
#[cfg(not(windows))]
fn primary_button_down() -> bool {
    true
}

#[tauri::command]
pub fn pet_stage_set_hitbox(rect: HitBox) {
    if let Ok(mut h) = hitbox().lock() {
        *h = Some(rect);
    }
}

/// 拖动期间强制不穿透: 系统拖拽时窗口跟着鼠标走, 但轮询和窗口移动有时差,
/// 快速甩动时鼠标会短暂落到包围盒外, 这时切成穿透会让拖拽当场断掉
#[tauri::command]
pub fn pet_stage_drag(active: bool) {
    DRAGGING.store(active, Ordering::SeqCst);
}
