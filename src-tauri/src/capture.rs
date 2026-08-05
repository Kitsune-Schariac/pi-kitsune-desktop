// 屏幕捕获: xcap 全屏截图 → PNG → base64
// 数据存内存, 发送时走 pi images 字段 (视觉模型需要像素, 路径无效)
use base64::Engine as _;

/// 截取主显示器全屏, 返回 { data: base64 PNG, mimeType: image/png }
/// MVP 只截第一个显示器; 区域截图后续 (截全屏 + 坐标裁剪)
#[tauri::command]
pub fn capture_screenshot() -> Result<serde_json::Value, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("枚举显示器失败: {e}"))?;
    let monitor = monitors.first().ok_or("未检测到显示器")?;
    let img = monitor
        .capture_image()
        .map_err(|e| format!("截屏失败: {e}"))?;
    // ImageBuffer → PNG 编码 (xcap 返回 ImageBuffer, 无自带编码方法)
    let mut png = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut png);
        img.write_to(&mut cursor, image::ImageFormat::Png)
            .map_err(|e| format!("PNG 编码失败: {e}"))?;
    }
    Ok(serde_json::json!({
        "data": base64::engine::general_purpose::STANDARD.encode(&png),
        "mimeType": "image/png",
    }))
}
