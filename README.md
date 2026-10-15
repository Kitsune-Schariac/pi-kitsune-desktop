<div align="center">

<img src="app-icon.png" width="96" alt="Pi Kitsune" />

# Pi Kitsune

**[pi](https://github.com/earendil-works/pi-coding-agent) 编码助手的桌面客户端 —— 不改 pi 一行代码，把命令行里的它变成多会话、看得见、管得住的桌面工作台。**

A desktop GUI for the pi coding agent, built with Tauri 2 + React. Fully open source under MIT.

[下载安装包](https://github.com/Kitsune-Schariac/pi-kitsune-desktop/releases) · [报告问题](https://github.com/Kitsune-Schariac/pi-kitsune-desktop/issues) · [参与贡献](#参与贡献)

</div>

---

## 为什么是 Pi Kitsune

pi 本身是一个很好的终端编码 agent，但一旦同时开几个项目、跑几个子代理、想知道钱花在了哪里，终端就不够用了。Pi Kitsune 想解决的是这件事，而且坚持几条原则：

**不分叉 pi，只当它的皮囊。** 应用通过 `pi --mode rpc` 驱动你本机全局安装的官方 pi，不内置、不魔改。你的模型配置、扩展、skill、prompt 模板、会话文件全部与终端版共用 —— 在 TUI 里开的会话可以在这里接着聊，反过来也一样。pi 升级，你直接升级 pi 就行。

**快，而且多开不卡。** 每个会话一个独立的 pi 子进程，由 Rust 侧的进程池按 LRU 管理；打开会话时会在后台预热一个同目录的 pi，下次点击直接复用，绕开 pi 约 3.5 秒的冷启动。被淘汰的会话内容仍留在内存里，切回来是秒切，不重读历史。

**尊重你的配置文件。** 可视化编辑 `models.json` 时，整份文档按原样读写，GUI 不认识的字段一个都不会丢；写入前做乐观锁校验、结构校验、自动备份，再用临时文件 + rename 原子替换。`settings.json` 则按 pi 自己的加锁协议，只合并改动过的键，不和正在运行的 pi 抢写。

**透明，看得见每一分钱。** 输入 / 输出 / 缓存读写 / 成本的 token 统计，缓存命中率实时栏，对话行为统计（轮数、工具分布、thinking 占比、自动重试与压缩次数、慢轮瀑布），子代理的 token 归属。拿不到的数据如实标「无数据」，不编造。

**不污染 agent 的上下文。** Git 面板直接调用系统 git，不经过 pi 的 bash 工具；看 diff、提交代码不会塞进模型的上下文窗口里。

**本地优先，没有遥测。** 所有数据都在你本机。应用自己发出的网络请求只有一种：你在设置里手动点「测试连接 / 拉取模型」时，向你填写的供应商地址发的那一次，密钥不进日志、不进错误信息。

**能降级就不报错。** 没装 Everything 就退回全量扫描；项目不用 Trellis 就安静隐藏任务面板；某个子代理产物解析失败只跳过那一条。单点故障不拖垮整个界面。

## 功能一览

### 对话

- **流式渲染**：实时消费 `text_delta` / `thinking` / `toolcall` 事件流，GFM Markdown + Shiki 语法高亮，时间线按轮次与步骤分组，检查器可下钻每一步的工具调用详情。
- **中途插话 / 停止后续写**：agent 运行中排队 steer 指导消息，停止后排队 followUp；队列以 pi 的 `queue_update` 事件为准，不做乐观插入。
- **附件**：直接粘贴或拖入图片与文件。图片以像素发给视觉模型，文本文件走路径引用由 agent 按需读取，超大图片自动退回路径模式。
- **@ 引用**：引用文件、目录、其他会话、skill。Windows 上可接入 Everything（`es.exe`）做毫秒级搜索。
- **屏幕截图**：一键截主显示器全屏随消息发送。
- **/ 命令面板**：内置命令（新建会话、切模型、思考级别、中止、skills / packages 面板）加上 pi 扩展、prompt、skill 透传的命令。
- **可点击的路径**：会话里出现的本地文件路径可以直接点开，程序内查看器带高亮，也能交给系统打开或在资源管理器中定位。
- **一键复制**：AI 回复、用户提问、代码块。
- **扩展 UI 协议**：完整支持 pi 扩展的 confirm / select / input / editor / notify 弹窗，FIFO 排队。

### 工作台

- **项目与会话历史**：扫描 `~/.pi/agent/sessions/`，按项目分组或按最近时间排列，支持预览、续聊、本地移除；侧栏直接添加项目目录并开新会话。
- **Git 工作台**：status / diff / log / show / stage / commit / checkout，中文路径不转义。
- **Subagent 舰队视图**：实时看到 [pi-subagents](https://github.com/nicobailon/pi-subagents) 派出的子代理当前在调什么工具，支持活动 / 历史分区、run 详情、子会话只读下钻。
- **Trellis 任务视图**：对使用 [Trellis](https://github.com/mindfold-ai/Trellis) 工作流的项目，展示任务树与 PRD / design 等产物。

### 设置与统计

- **模型与供应商**：三栏可视化增删改 `models.json`，支持测试连接、从 `/models` 拉取模型列表、thinking level 映射可视化、设置新会话默认模型。
- **运行中热切换**：provider / model / thinking level 随时切。
- **Token 统计 / 行为统计**：按时间与项目筛选，两者共用同一遍索引，口径一致。

### 个性化

- **纯色主题**：内置 8 套按颜色命名的主题（默认「雪白」），oklch 色阶，切换带淡入淡出。可以自己写皮肤包。
- **桌面宠物**：透明置顶小窗，按全部会话的聚合状态播放帧动画（待机 / 打招呼 / 思考 / 执行工具 / 报错 / 离线），可拖动、滚轮缩放、右键换角色。宠物包同样可以自制。

## 安装

### 直接下载

到 [Releases](https://github.com/Kitsune-Schariac/pi-kitsune-desktop/releases) 下载最新安装包。

**前置条件**：本机已全局安装 pi，且 `pi --version` 能正常执行。

```bash
npm i -g @earendil-works/pi-coding-agent
```

可选：Windows 用户把 [Everything](https://www.voidtools.com/) 的 `es.exe` 放进 PATH，@ 引用搜索会快很多；不装也能用。

### 平台说明

目前在 **Windows 11** 上开发和日常使用，这是唯一经过充分验证的平台。代码基于 Tauri 2，理论上可以在 macOS / Linux 构建，部分 Windows 专属能力（Everything 加速等）会自动降级，但尚未实测。欢迎在其他平台上试用并反馈。

## 从源码构建

需要 **Node.js 20+** 与 **Rust 工具链**（`rustup` + `cargo`），以及上面的 pi CLI。

```bash
npm install
npm run tauri dev      # 开发模式：同时拉起 Vite（固定 1420 端口）与 Tauri 窗口
npm run tauri build    # 打包当前平台安装包
```

版本号分散在 `package.json`、`tauri.conf.json`、`Cargo.toml` 里，发版时用脚本一次同步：

```bash
node bump-version.mjs 0.3.4
```

## 架构

```
React (Zustand)
   │  invoke()                      emit("pi_event" / "session_evicted")
   ▼                                    ▲
Tauri 命令层 (lib.rs) ─── 多会话进程池 (LRU + 预热槽) ───┐
   │ stdin (JSON-RPC 命令)                               │
   ▼                                                     │
pi 子进程 (pi --mode rpc) ── stdout 按行分流 ────────────┘
                        ├─ response (带 id) → oneshot 回送给请求方
                        └─ event            → Tauri emit 转发前端
```

- **请求-响应**：命令带 id 存入待响应表，stdout reader 收到对应 response 后唤醒，30 秒超时兜底。
- **事件流**：`text_delta` / `thinking_delta` / `toolcall_*` / `queue_update` / `extension_ui_request` / `notify` 等经 Tauri 全局事件派发到会话 store。
- **Detached / Reattach**：进程被 LRU 淘汰时前端标记 detached 并保留内容；切回时复用历史，并用 mtime 守卫避免无谓重读。

技术栈：React 19 · TypeScript · Vite 6 · TailwindCSS 3 · Zustand 5 · Shiki · lucide-react ｜ Rust · Tauri 2 · tokio · reqwest (rustls) · xcap

<details>
<summary>项目结构</summary>

```
pi-kitsune-desktop/
├── src/                         # 前端 React
│   ├── App.tsx                  # 主界面外壳
│   ├── main.tsx                 # 入口：全局注册 pi_event / session_evicted 监听
│   ├── pet/                     # 桌宠窗口独立渲染入口
│   ├── components/
│   │   ├── shell/               #   外壳：侧轨、会话区、检查器
│   │   ├── timeline/            #   对话时间线
│   │   ├── inspector/           #   会话概览、步骤详情
│   │   ├── settings/            #   设置窗：模型、主题、统计、桌宠
│   │   ├── panels/              #   skills / packages 面板
│   │   ├── refs/                #   @ 引用相关弹层
│   │   └── *SidebarPanel.tsx    #   Git / 舰队 / Trellis 面板
│   ├── store/                   # Zustand stores（会话状态机、项目、主题、git、舰队…）
│   └── lib/                     # pi 事件类型、命令模型、时间线推导、引用工具
├── src-tauri/                   # Rust 后端
│   ├── src/
│   │   ├── lib.rs               # 命令注册 + 多会话进程池 + 预热槽
│   │   ├── pi_runtime.rs        # pi 子进程封装：spawn / RPC 收发 / response 关联
│   │   ├── session_fs.rs        # 会话文件扫描与读写
│   │   ├── models_config.rs     # models.json 保真读写
│   │   ├── settings_config.rs   # settings.json 加锁合并写
│   │   ├── provider_probe.rs    # 供应商连通性测试
│   │   ├── token_stats.rs       # token / 成本统计
│   │   ├── behavior_stats.rs    # 对话行为统计
│   │   ├── git.rs               # Git 工作台
│   │   ├── subagent_fleet.rs    # 子代理舰队数据源
│   │   ├── trellis_tasks.rs     # Trellis 任务数据源
│   │   ├── attach.rs            # 粘贴 / 拖入附件
│   │   ├── local_path.rs        # 会话内路径解析与文件查看
│   │   ├── search.rs            # @ 引用 Everything 加速
│   │   ├── capture.rs           # 屏幕截图
│   │   ├── skins.rs / pets.rs   # 皮肤包 / 宠物包扫描
│   ├── resources/skins/         # 内置主题
│   └── resources/pets/          # 内置宠物包目录
└── bump-version.mjs             # 版本号同步脚本
```

</details>

## 自制皮肤

皮肤包放在 `~/.pi-kitsune/skins/<skin-id>/`，id 与内置主题冲突时内置优先。

```
<skin-id>/
├── skin.json        # 必需：元信息 + 色阶 + 浅/深方向
└── override.css     # 可选：样式覆盖（选择器建议带 [data-theme] 前缀防串扰）
```

```json
{
  "id": "white",
  "name": "雪白 · 亮",
  "author": "Pi Kitsune",
  "version": "1.0",
  "base": "light",
  "colors": {
    "bg": "oklch(100% 0 0)",
    "fg": "oklch(20% 0 0)",
    "accent": "oklch(22% 0 0)"
  },
  "override": "override.css"
}
```

`colors` 里每个 key 都会写成 `:root` 上的 `--<key>` 变量，没声明的项按 `base` 方向回落到默认值。设置页的预览是按配色绘制的骨架缩略图，不需要预览图。可用的变量名参考 [`src-tauri/resources/skins/`](src-tauri/resources/skins/) 下的内置主题。

## 自制桌宠

宠物包放在 `~/.pi-kitsune/pets/<pet-id>/`：

```
<pet-id>/
├── pet.json          # 必需：元信息 + 帧尺寸 + 动画表
└── spritesheet.webp  # 必需：精灵图，行 = 状态，列 = 帧
```

```json
{
  "id": "my-pet",
  "displayName": "My Pet",
  "description": "一只会陪你写代码的小家伙",
  "spritesheetPath": "spritesheet.webp",
  "frameWidth": 192,
  "frameHeight": 208,
  "animations": {
    "idle":     { "row": 0, "frames": 6, "duration": 1800, "loop": true },
    "greet":    { "row": 3, "frames": 4, "duration": 1000, "loop": true },
    "thinking": { "row": 4, "frames": 5, "duration": 1500, "loop": true },
    "working":  { "row": 7, "frames": 6, "duration": 900,  "loop": true },
    "error":    { "row": 5, "frames": 8, "duration": 1400, "loop": true },
    "offline":  { "row": 5, "frames": 8, "duration": 2000, "loop": false }
  }
}
```

- `row` 从 0 开始；`duration` 是**一轮播完的总毫秒数**，不是单帧时长；`loop: false` 播完停在末帧。
- `animations` 必须包含 `idle`，它是其余状态缺失时的回落目标，缺了整包会被跳过。
- 状态聚合规则：任一会话在跑工具 → `working`，任一在流式输出 → `thinking`，有会话但全空闲 → `idle`，无会话 → `offline`；工具报错闪 `error` 约 2 秒后归位。

## 开放策略

Pi Kitsune 是一个**完全开源**的项目：

- **代码全部公开**，以 [MIT 许可证](LICENSE) 发布。你可以自由使用、修改、再分发，包括商用和二次开发，只需保留版权声明。
- **没有闭源部分，没有付费版，没有遥测。** 你从这里看到的就是安装包里的全部。
- **开发过程公开。** 版本按 [Releases](https://github.com/Kitsune-Schariac/pi-kitsune-desktop/releases) 发布，每个版本附带变更说明；功能规划和问题讨论都在 Issues 里进行。
- **独立的社区项目。** Pi Kitsune 与 pi 官方没有隶属关系，它只是 pi 的一个第三方客户端。pi 本身的问题请反馈到 [pi 的仓库](https://github.com/earendil-works/pi-coding-agent)。

## 参与贡献

非常欢迎 Issue 和 Pull Request。

- **报告问题**：请附上系统版本、Pi Kitsune 版本、`pi --version` 的输出，以及复现步骤。界面问题附一张截图会快很多。
- **提议功能**：先开个 Issue 聊一聊，确认方向再动手，避免白做。
- **提交代码**：
  1. Fork 并从 `main` 切出分支，例如 `feat/xxx`、`fix/xxx`。
  2. 跟着周围代码的风格写：命名习惯、注释密度、目录约定保持一致；注释写「为什么这么做」，而不是复述代码。
  3. 提交前确认 `npm run build`（TypeScript 类型检查 + 前端构建）和 `cargo check`（在 `src-tauri/` 下）都能通过。
  4. 提交信息用 `feat:` / `fix:` / `chore:` 等前缀，一句话说清改了什么。
- **分享皮肤与宠物**：欢迎投稿。请确保素材是你原创或有权分发的，**不接受未授权的版权角色或商标素材**。

## 许可

[MIT](LICENSE) © 2026 [汉江](https://github.com/Kitsune-Schariac)
