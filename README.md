# Pi Kitsune

> [pi](https://github.com/earendil-works/pi-coding-agent) 编码助手的 Tauri 2 桌面 GUI 客户端。
>
> 一只九尾狐皮囊，把命令行里的 pi 包装成多会话、可换肤、流式对话的桌面体验。

---

## 功能特性

- **多会话 sidecar 进程池** —— 每个 pi 会话独立 `spawn` 一个 `pi --mode rpc` 子进程；LRU 淘汰最久未活动的进程，并带预热槽（warm slot）：打开会话即在后台预 spawn 同 cwd 的 pi，下次点击直接复用，绕开 pi 约 3.5s 的冷启动。
- **流式对话渲染** —— 实时消费 `text_delta` / `thinking` / `toolcall` 事件流，Markdown（GFM）+ Shiki 语法高亮，消息气泡框可选开关、可调底色与不透明率，文字色随底色亮度联动。
- **项目与会话历史** —— 扫描 `~/.pi/agent/sessions/`，侧边栏以项目分组折叠展示历史会话，支持预览、续聊（reattach）、本地移除。
- **主题皮肤系统** —— 皮肤包由 `skin.json`（色阶 + 浅/深 base 方向）+ 可选背景图 + `override.css` 组成；会话区 / 侧边栏不透明率独立可调，背景模糊度可调。内置 `light-sky` / `tohsaka-rin` 两套。
- **@ 引用文件搜索** —— Windows 上调用 Everything (`es.exe`) 做毫秒级路径加速，失败时静默降级回递归全量扫描，绝不让 @ 引用整体不可用。
- **屏幕截图** —— `xcap` 截主显示器全屏 → PNG base64，随消息发给视觉模型（像素级，路径无效）。
- **/ 命令面板** —— 本地白名单命令（新建会话 / 切换模型 / 思考级别 / 中止 / 打开 skills / packages 面板）+ pi 透传命令（来自扩展 / prompt / skill）。
- **模型与思考级别切换** —— 运行中热切换 provider / model 与 thinking level。
- **Token 统计** —— 输入 / 输出 / cache 读写 / 成本，会话级统计面板实时呈现。
- **扩展 UI 协议** —— `extension_ui_request` 弹窗（confirm / select / input / editor / notify）按 FIFO 队列弹一个，关一个弹下一个；`notify` 通知条 fire-and-forget，按源会话归属，无会话走右下角兜底。
- **中途 steer / 停止后 followUp** —— agent 运行中排队指导消息，agent 停止后排队的后续消息；队列内容由 pi `queue_update` 事件权威回推，不做乐观插入。
- **Detached 秒切缓存** —— pi 进程被 LRU 淘汰后会话条目（entries）仍常驻内存（上限 20 条），切回时走 reattach 秒切，不重读历史。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 19 · TypeScript · Vite 6 · TailwindCSS 3 · Zustand 5 · react-markdown + remark-gfm · Shiki · lucide-react |
| 后端 | Rust · Tauri 2 · serde / serde_json · tokio · xcap · image · encoding_rs · tauri-plugin-dialog / clipboard-manager |
| 通信 | spawn `pi --mode rpc` 子进程：stdin 发 JSON-RPC 命令，stdout 按行分流（response 走 oneshot 回送，event 经 Tauri emit 转发前端） |

## 前置要求

- **Node.js**（建议 20+）
- **Rust 工具链**（`rustup` + `cargo`，用于编译 Tauri 后端）
- **pi CLI**（全局安装）：

  ```bash
  npm i -g @earendil-works/pi-coding-agent
  ```

  确认 `pi --version` 可正常执行；本应用通过子进程方式驱动它，不内置 pi。
- *(可选)* **Everything**（仅 Windows）：把 `es.exe` 放进 PATH 即可启用 @ 引用的毫秒级搜索加速；没装也能用，自动降级。

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（同时拉起 Vite dev server 与 Tauri 窗口）
npm run tauri dev

# 打包当前平台安装包
npm run tauri build
```

开发模式下 Vite dev server 固定跑在 `1420` 端口（`strictPort`），Tauri 按约定加载。

## 项目结构

```
pi-kitsune-desktop/
├── src/                        # 前端 React
│   ├── App.tsx                  # 主界面：背景层 + 侧边栏 + 会话主区 + 面板抽屉
│   ├── main.tsx                 # 入口：全局注册 pi_event / session_evicted 监听
│   ├── components/              # UI 组件
│   │   ├── settings/            #   设置窗口、主题面板、token 统计面板
│   │   ├── panels/              #   skills / packages 面板
│   │   └── refs/                #   @ 引用、提及、会话选择、技能选择
│   ├── store/                   # Zustand stores
│   │   ├── session.ts           #   会话状态机（多 session、流式、队列、UI 请求）
│   │   ├── projects.ts          #   项目 / 会话历史侧边栏
│   │   └── theme.ts             #   主题皮肤系统
│   └── lib/                     # pi 事件类型、命令模型、引用工具
├── src-tauri/                   # Rust 后端
│   ├── src/
│   │   ├── lib.rs               # 命令注册 + 多 session 运行时池 + 预热槽
│   │   ├── pi_runtime.rs        # pi 子进程封装：spawn / RPC 收发 / response 关联
│   │   ├── session_fs.rs        # ~/.pi/agent/sessions/ 扫描与会话条目读写
│   │   ├── skins.rs             # 皮肤包扫描与资源读取
│   │   ├── token_stats.rs       # token / 成本统计
│   │   ├── search.rs            # @ 引用 Everything 加速层
│   │   └── capture.rs           # 屏幕截图
│   ├── resources/skins/         # 内置皮肤包（打包进 bundle）
│   └── tauri.conf.json
└── skin-files/                  # 皮肤素材源（gitignored，正式资源在 resources/skins/）
```

## 皮肤系统

皮肤包放在 `src-tauri/resources/skins/<skin-id>/`，结构如下：

```
<skin-id>/
├── skin.json        # 必需：元信息 + 色阶 + base 方向
├── bg.jpg           # 可选：背景图（has_bg = true 时读取并注入 --bg-image）
├── override.css     # 可选：自定义样式覆盖（建议选择器带 [data-theme] 前缀防串扰）
└── preview.jpg      # 可选：设置面板预览图
```

`skin.json` 示例：

```json
{
  "id": "tohsaka-rin",
  "name": "远坂凛",
  "author": "hanjiang",
  "version": "1.0.0",
  "base": "light",
  "colors": {
    "primary-50": "253 242 244",
    "primary-500": "236 72 112",
    "primary-900": "120 20 40",
    "panel": "255 255 255",
    "bubble-bg": "255 255 255"
  },
  "has_bg": true,
  "has_override": true,
  "bubble": true
}
```

切换皮肤时，前端会清掉上一套写过的 CSS 变量再写入新的一组，注入 / 移除 `override.css`，并做约 220ms 的淡入淡出过渡。`bubble` 字段是皮肤推荐的气泡框开关，仅当用户从未手动改过时生效。

## 架构要点

前端与 pi 的通信链路：

```
React (Zustand)
   │  invoke()                      emit("pi_event"/"session_evicted")
   ▼                                    ▲
Tauri 命令层 (lib.rs) ─── 多 session 运行时池 (LRU + warm) ──┐
   │ stdin (JSON-RPC 命令)                                  │
   ▼                                                        │
pi 子进程 (pi --mode rpc) ── stdout 按行分流 ─────────────┘
                        ├─ response (带 id) → oneshot 回送给 send_request
                        └─ event           → Tauri emit 转发前端
```

- **request-response**：发命令时生成 id 存入待响应表，stdout reader 收到对应 response 后取出 oneshot 唤醒，30s 超时防 pi 不响应。
- **event 流**：`text_delta` / `thinking_delta` / `toolcall_*` / `queue_update` / `extension_ui_request` / `notify` 等事件经 Tauri 全局 `listen` 派发到 session store。
- **Detached / Reattach**：Rust 侧 LRU 淘汰 pi 进程时 emit `session_evicted`，前端标记 detached（entries 保留）；用户切回时走 reattach 复用历史，并做 mtime 守卫避免无谓重读。

## 许可与作者

私有项目 · 作者 [汉江](https://github.com/)。