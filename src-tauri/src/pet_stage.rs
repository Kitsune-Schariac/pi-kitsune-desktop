// 桌宠舞台线程: 动态点击穿透 + 移动 / 下落 / 贴地
//
// 桌宠窗口是一张比角色大的透明画布 (要给气泡、跳跃留位置), 透明区域不能挡住身后的窗口。
// 做法: 窗口默认穿透, 鼠标进到角色包围盒时才关掉穿透。
// 判定必须放在 Rust 侧轮询全局鼠标 —— 穿透打开后 WebView 收不到任何 mousemove,
// 前端没法自己知道鼠标"回来了"。
//
// 移动和下落也在这条线程里逐帧推窗口: 前端只下"走到哪 / 停"的指令, 不按帧发 IPC。
// 位置一律以"脚底点"(窗口底边中点) 对外, 与前端 canvas.ts 的约定一致。
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
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

/// 前端下发的移动指令, 由舞台线程在下一轮取走执行
#[derive(Clone, Copy)]
enum Request {
    /// 目标脚底 x 与速度, 都是逻辑像素
    MoveTo { x: f64, speed: f64 },
    Stop,
}

/// 线程内的运动状态; 坐标是窗口左上角的物理像素, 用 f64 累积,
/// 慢速行走时每帧位移不到 1 像素, 按整数累积会原地不动
enum Motion {
    Idle,
    Walk { x: f64, target: f64, speed: f64, clamped: bool },
    Fall { y: f64, vy: f64 },
}

static HITBOX: OnceLock<Mutex<Option<HitBox>>> = OnceLock::new();
static REQUEST: OnceLock<Mutex<Option<Request>>> = OnceLock::new();
static DRAGGING: AtomicBool = AtomicBool::new(false);
/// 重力: 0 = 前端还没告知, 1 = 关, 2 = 开。
/// 必须有"未知"态: 开窗瞬间配置还没到, 若默认按开处理, 关了重力的用户会被先拽到地面再也回不去
static GRAVITY: AtomicU8 = AtomicU8::new(0);
/// 线程代际: 每次开窗 +1, 旧线程发现代际变了就退出。
/// 关窗后立刻重开时, 旧线程可能还没察觉窗口没了, 不靠代际会出现两个线程抢着切穿透
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn hitbox() -> &'static Mutex<Option<HitBox>> {
    HITBOX.get_or_init(|| Mutex::new(None))
}

fn request() -> &'static Mutex<Option<Request>> {
    REQUEST.get_or_init(|| Mutex::new(None))
}

/// 鼠标在宠物窗口附近时的轮询间隔; 离得远就放慢 —— 它总得先移过来才可能点到宠物
const TICK_NEAR: Duration = Duration::from_millis(33);
const TICK_FAR: Duration = Duration::from_millis(100);
/// 下落速度快 (落地前每秒上千像素), 按 60fps 推窗口, 30fps 会一跳一跳
const TICK_FALL: Duration = Duration::from_millis(16);
/// 走路慢, 30fps 每步才两三个像素已经足够顺; 每次挪窗口都要牵动 WebView2 重新定位与合成,
/// 实测 60fps 走路占单核 6.9%, 不值得
const TICK_WALK: Duration = Duration::from_millis(33);
/// "附近"= 窗口矩形外扩这么多物理像素。慢速档 100ms 里鼠标走不了太远, 外扩一圈保证
/// 鼠标进到角色之前已经切回快速档, 不会出现"指上去要等一下才能点"
const NEAR_MARGIN: f64 = 200.0;
/// 缩放比与工作区只在跨显示器 / 任务栏变化时才变, 每轮都问的话要排队到主线程, 一秒刷新一次足够
const MONITOR_REFRESH: Duration = Duration::from_secs(1);
/// 重力加速度, 逻辑像素/秒²。按真实比例会慢得像飘, 这个值让一屏高度约 1 秒落地
const GRAVITY_ACCEL: f64 = 2400.0;
/// 脚底与地面差这么多物理像素以内算"站在地上", 吸收缩放取整误差
const GROUND_EPS: f64 = 2.0;

/// 一次采样: 全局鼠标位置 + 窗口外框, 都是物理像素
struct Probe {
    cx: f64,
    cy: f64,
    wx: f64,
    wy: f64,
    ww: f64,
    wh: f64,
}

/// 工作区 (扣掉任务栏), 物理像素
#[derive(Clone, Copy)]
struct Area {
    left: f64,
    right: f64,
    bottom: f64,
}

/// 推窗口用的句柄: Windows 直接拿 HWND 调系统 API, 其他平台走 Tauri 窗口接口
#[cfg(windows)]
type Handle = isize;
#[cfg(not(windows))]
type Handle = tauri::WebviewWindow;

/// 开窗后调用: 起一条舞台线程, 窗口销毁或被新一代取代时自行退出
pub fn start(app: tauri::AppHandle) {
    let gen = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut h) = hitbox().lock() {
        *h = None;
    }
    if let Ok(mut r) = request().lock() {
        *r = None;
    }
    DRAGGING.store(false, Ordering::SeqCst);
    GRAVITY.store(0, Ordering::SeqCst);

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
        let mut area = work_area(&win);
        let mut monitor_at = Instant::now();
        // None = 还没设置过, 保证第一轮一定下发一次穿透状态
        let mut last_ignore: Option<bool> = None;
        let mut motion = Motion::Idle;
        let mut was_dragging = false;
        let mut last_tick = Instant::now();
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
            // 卡顿 (系统休眠、主线程忙) 后 dt 会很大, 夹住免得一帧瞬移
            let dt = started.duration_since(last_tick).as_secs_f64().min(0.05);
            last_tick = started;

            if monitor_at.elapsed() >= MONITOR_REFRESH {
                if let Ok(s) = win.scale_factor() {
                    scale = s;
                }
                area = work_area(&win).or(area);
                monitor_at = Instant::now();
            }

            // 拖动结束由这里判定: 系统拖拽的模态移动循环会吞掉松手消息 (tao 只给原生窗口补发
            // WM_LBUTTONUP, WebView 里的页面收不到 mouseup), 前端没法自己知道拖完了
            if DRAGGING.load(Ordering::SeqCst) && !primary_button_down() {
                DRAGGING.store(false, Ordering::SeqCst);
            }
            let dragging = DRAGGING.load(Ordering::SeqCst);

            #[cfg(windows)]
            let (probe, handle) = (probe_win32(hwnd), hwnd);
            #[cfg(not(windows))]
            let (probe, handle) = (probe_tauri(&app, &win), win.clone());

            // 拖动中一切位移让位给系统拖拽, 未执行的指令也作废 (松手后由大脑重新决定)
            let req = request().lock().ok().and_then(|mut r| r.take());
            if dragging {
                motion = Motion::Idle;
            } else if let (Some(req), Some(p)) = (req, &probe) {
                motion = match req {
                    Request::Stop => Motion::Idle,
                    Request::MoveTo { x, speed } => walk_motion(p, area, scale, x, speed),
                };
            }

            if let Some(p) = &probe {
                if was_dragging && !dragging {
                    emit(&app, "dragEnd", p, scale);
                    // 松手在半空且开着重力 → 掉下去; 落地点由 landed 事件回报
                    if gravity_on() {
                        if let Some(a) = area {
                            if p.wy + p.wh < a.bottom - GROUND_EPS {
                                motion = Motion::Fall { y: p.wy, vy: 0.0 };
                                emit(&app, "fall", p, scale);
                            }
                        }
                    }
                }
                if !dragging {
                    // 贴地检查只在本轮开始时就静止才做: 本轮刚落地 / 刚走到的话, 采样 p 还是
                    // 移动前的位置, 拿它判断会把刚落地的宠物当成悬空再贴一次
                    let idle_before = matches!(motion, Motion::Idle);
                    step_motion(&app, &handle, &mut motion, p, area, scale, dt);
                    // 站着不动却不在地面上 (开窗、任务栏变化、刚打开重力) → 直接贴地, 不播下落:
                    // 这些都不是"被扔下去", 演一段坠落反而奇怪
                    if idle_before && gravity_on() {
                        if let Some(a) = area {
                            let foot = p.wy + p.wh;
                            if (foot - a.bottom).abs() > GROUND_EPS {
                                let y = a.bottom - p.wh;
                                set_window_y(&handle, p, y);
                                let snapped = Probe { wy: y, ..*p };
                                emit(&app, "snapped", &snapped, scale);
                            }
                        }
                    }
                }
            }
            was_dragging = dragging;

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

            let tick = if matches!(motion, Motion::Fall { .. }) {
                TICK_FALL
            } else if matches!(motion, Motion::Walk { .. }) || dragging || near {
                TICK_NEAR
            } else {
                TICK_FAR
            };
            std::thread::sleep(tick.saturating_sub(started.elapsed()));
        }
    });
}

fn gravity_on() -> bool {
    GRAVITY.load(Ordering::SeqCst) == 2
}

/// 把"走到脚底 x"换算成窗口左上角的目标 x, 并夹在工作区内 (角色整个身子留在屏幕里)
fn walk_motion(p: &Probe, area: Option<Area>, scale: f64, foot_x: f64, speed: f64) -> Motion {
    let half_win = p.ww / 2.0;
    let mut target_foot = foot_x * scale;
    let mut clamped = false;
    if let Some(a) = area {
        // 包围盒还没上报时按画布一半宽估, 宁可离边缘远一点
        let half_body = hitbox()
            .lock()
            .ok()
            .and_then(|h| *h)
            .map_or(p.ww / 4.0, |hb| hb.w * scale / 2.0);
        let lo = a.left + half_body;
        let hi = a.right - half_body;
        if lo < hi {
            let c = target_foot.clamp(lo, hi);
            clamped = c != target_foot;
            target_foot = c;
        }
    }
    Motion::Walk {
        x: p.wx,
        target: target_foot - half_win,
        speed: speed.max(1.0) * scale,
        clamped,
    }
}

fn step_motion(
    app: &tauri::AppHandle,
    handle: &Handle,
    motion: &mut Motion,
    p: &Probe,
    area: Option<Area>,
    scale: f64,
    dt: f64,
) {
    match motion {
        Motion::Idle => {}
        Motion::Walk { x, target, speed, clamped } => {
            let step = *speed * dt;
            let arrived = (*target - *x).abs() <= step;
            *x = if arrived { *target } else { *x + step * (*target - *x).signum() };
            set_window_x(handle, p, *x);
            if arrived {
                let at = Probe { wx: *x, ..*p };
                emit(app, if *clamped { "edge" } else { "arrived" }, &at, scale);
                *motion = Motion::Idle;
            }
        }
        Motion::Fall { y, vy } => {
            let Some(a) = area else {
                *motion = Motion::Idle;
                return;
            };
            *vy += GRAVITY_ACCEL * scale * dt;
            *y += *vy * dt;
            let ground = a.bottom - p.wh;
            let landed = *y >= ground;
            if landed {
                *y = ground;
            }
            set_window_y(handle, p, *y);
            if landed {
                let at = Probe { wy: *y, ..*p };
                emit(app, "landed", &at, scale);
                *motion = Motion::Idle;
            }
        }
    }
}

/// 舞台事件: 统一带上脚底点 (逻辑像素), 前端据此落盘, 不必再回头问窗口位置
fn emit(app: &tauri::AppHandle, kind: &str, p: &Probe, scale: f64) {
    let foot_x = (p.wx + p.ww / 2.0) / scale;
    let foot_y = (p.wy + p.wh) / scale;
    let _ = app.emit_to(
        "pet",
        "pet_stage",
        serde_json::json!({ "kind": kind, "foot": { "x": foot_x, "y": foot_y } }),
    );
}

fn work_area(win: &tauri::WebviewWindow) -> Option<Area> {
    let m = win.current_monitor().ok()??;
    let r = m.work_area();
    Some(Area {
        left: r.position.x as f64,
        right: r.position.x as f64 + r.size.width as f64,
        bottom: r.position.y as f64 + r.size.height as f64,
    })
}

fn set_window_x(handle: &Handle, p: &Probe, x: f64) {
    set_window_pos(handle, x.round(), p.wy);
}

fn set_window_y(handle: &Handle, p: &Probe, y: f64) {
    set_window_pos(handle, p.wx, y.round());
}

/// Windows 直接 SetWindowPos: 走 Tauri 的 set_position 每帧都要排队到主线程, 60fps 下开销明显
#[cfg(windows)]
fn set_window_pos(hwnd: &Handle, x: f64, y: f64) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
    };
    unsafe {
        SetWindowPos(
            *hwnd as _,
            std::ptr::null_mut(),
            x as i32,
            y as i32,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

#[cfg(not(windows))]
fn set_window_pos(win: &tauri::WebviewWindow, x: f64, y: f64) {
    let _ = win.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
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

/// 走到脚底 x (逻辑像素), speed 为逻辑像素/秒; 到达发 arrived, 被屏幕边缘挡住发 edge
#[tauri::command]
pub fn pet_stage_move_to(x: f64, speed: f64) {
    if let Ok(mut r) = request().lock() {
        *r = Some(Request::MoveTo { x, speed });
    }
}

#[tauri::command]
pub fn pet_stage_stop() {
    if let Ok(mut r) = request().lock() {
        *r = Some(Request::Stop);
    }
}

#[tauri::command]
pub fn pet_stage_set_gravity(on: bool) {
    GRAVITY.store(if on { 2 } else { 1 }, Ordering::SeqCst);
}
