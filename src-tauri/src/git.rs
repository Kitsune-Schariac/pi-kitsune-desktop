//! Git 面板后端: 直调系统 git (不经 pi bash 通道, 避免输出污染 LLM 上下文)
//!
//! 只读命令: status / diff / branches / log / show。写操作 (stage / commit / checkout)
//! 在后续步骤实现。所有 git 调用走 run_git 统一入口, Windows 必加 CREATE_NO_WINDOW
//! 抑制打包版控制台黑窗, 参数固定带 -c core.quotepath=false 保证中文路径不转义。

use serde::Serialize;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 统一 git 调用入口: 在 cwd 下执行 `git -c core.quotepath=false <args>`, UTF-8 解码 stdout。
/// - spawn 失败 (git 不在 PATH) → 中文提示, 不抛 OS 原始错误
/// - 非零退出码 → Err(stderr 原文), 由调用方决定上抛还是识别为「非仓库」正常状态
fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd)
        // core.quotepath=false: git 默认把非 ASCII 路径转义成 "\344\270\255..." 八进制,
        // 本机用户名/项目路径含中文, 不处理则文件名乱码且回传路径给 git diff 找不到文件
        .args(["-c", "core.quotepath=false"])
        .args(args);
    #[cfg(windows)]
    {
        // 打包版 (GUI 子系统无控制台) spawn git 会新分配控制台弹黑窗; 开发版父进程
        // 自带控制台不弹, 故此 flag 必加, 否则 bug 只在打包后暴露 (同 pi_runtime/search.rs)
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(|e| {
        // NotFound = git 不在 PATH: 给可读的中文修复提示, 对齐 pi_runtime spawn 失败做法
        if e.kind() == std::io::ErrorKind::NotFound {
            "未找到 git 命令, 请确认已安装并在 PATH 中".to_string()
        } else {
            format!("启动 git 失败: {e}")
        }
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        // git 部分失败信息只走 stdout, stderr 是空的 (实测「无改动可提交」即如此:
        // stdout 含 "nothing to commit" / "Changes not staged" 等原因, stderr 空)。
        // 只看 stderr 会让用户只得到「git 退出码 1」——信息量为零, 违背 design 风险条目
        // 「commit 失败原因必须让用户看到」的意图。故取值优先级: stderr > stdout > 退出码。
        return Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("git 退出码 {}", output.status.code().unwrap_or(-1))
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

// --- 返回结构 (强类型, snake_case 透传, 与 DirEntry 等现有结构一致) ---

/// 变更语义类型: 不透传 git 原始字母码 (那是给命令行用户的), GUI 用语义标签
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum GitChangeType {
    Modified,
    Added,
    Deleted,
    Renamed,   // 含 copy (R/C 合并, GUI 不必区分)
    Untracked, // 仅工作区 (XY = ??), 由 `? ` 行产生
    Conflict,  // 合并冲突 (U)
}

#[derive(Serialize, Clone)]
pub struct GitFileChange {
    pub path: String,
    /// 重命名条目的原路径 (v2 `2 ` 行的 oldPath); 非重命名为 None
    pub old_path: Option<String>,
    /// 暂存区状态 (v2 XY 的 X 位); None = 该侧无变更
    pub staged: Option<GitChangeType>,
    /// 工作区状态 (v2 XY 的 Y 位); None = 该侧无变更
    pub unstaged: Option<GitChangeType>,
}

#[derive(Serialize, Clone)]
pub struct GitStatus {
    /// false = 当前目录非 git 仓库 (安静降级, 前端显示「非 Git 仓库」, 不报错)
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub files: Vec<GitFileChange>,
}

#[derive(Serialize, Clone)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct GitLogEntry {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[derive(Serialize, Clone)]
pub struct GitShowResult {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
    /// unified patch 原文, 交给 DiffView 渲染 (与工具卡片 diff 同一组件)
    pub patch: String,
}

// --- 解析 ---

/// v2 XY 两位 → (暂存区, 工作区) 语义状态。X=staged, Y=unstaged
fn parse_xy(xy: &str) -> (Option<GitChangeType>, Option<GitChangeType>) {
    let mut chars = xy.chars();
    let staged = code_to_type(chars.next().unwrap_or('.'));
    let unstaged = code_to_type(chars.next().unwrap_or('.'));
    (staged, unstaged)
}

/// 单个状态码字母 → 语义类型。'.' = 无变更 → None; 未知码也兜底 None
fn code_to_type(c: char) -> Option<GitChangeType> {
    match c {
        'M' | 'T' => Some(GitChangeType::Modified), // T=类型改变, GUI 归入修改
        'A' => Some(GitChangeType::Added),
        'D' => Some(GitChangeType::Deleted),
        'R' | 'C' => Some(GitChangeType::Renamed), // C=拷贝, GUI 归入重命名
        'U' => Some(GitChangeType::Conflict),
        _ => None,
    }
}

/// 解析 `git status --porcelain=v2 --branch -z` 输出。
/// -z 用 NUL 分隔所有条目 (含 `#` 头行), 路径可能含空格/换行/中文都安全。
/// 重命名条目 (`2 ` 开头) 在 -z 下占两个连续 NUL 字段 (oldPath, newPath),
/// 少读一个会让后续全部错位 —— 这是 -z 模式最容易踩的坑。
fn parse_status(raw: &str) -> GitStatus {
    let tokens: Vec<&str> = raw.split('\0').collect();
    let mut branch = None;
    let mut upstream = None;
    let mut ahead = None;
    let mut behind = None;
    let mut files = Vec::new();

    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        if tok.is_empty() {
            i += 1;
            continue;
        }
        if let Some(v) = tok.strip_prefix("# branch.head ") {
            branch = Some(v.to_string());
        } else if let Some(v) = tok.strip_prefix("# branch.upstream ") {
            upstream = Some(v.to_string());
        } else if let Some(v) = tok.strip_prefix("# branch.ab ") {
            // 格式 `+<n> -<n>` (ahead/behind); 无 upstream 时此行不出现
            let mut it = v.split_whitespace();
            ahead = it.next().and_then(|s| s.trim_start_matches('+').parse().ok());
            behind = it.next().and_then(|s| s.trim_start_matches('-').parse().ok());
        } else if let Some(rest) = tok.strip_prefix("1 ") {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>  (strip 前缀后 8 字段, path=f[7])
            // splitn(8) 保证第 8 段含 path 剩余 (含空格也完整, NUL 已切断 token)
            let f: Vec<&str> = rest.splitn(8, ' ').collect();
            if f.len() == 8 {
                let (staged, unstaged) = parse_xy(f[0]);
                files.push(GitFileChange { path: f[7].to_string(), old_path: None, staged, unstaged });
            }
        } else if let Some(rest) = tok.strip_prefix("2 ") {
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <新路径>\0<原路径>
            // 两个反直觉点 (按 `git mv` 实测输出订正, 别凭文档记忆臆测):
            // (1) <hI> 之后还有一个独立字段 <X><score> (如 R100), splitn 必须切 9 段,
            //     否则 score 会粘进路径;
            // (2) 顺序是「新路径在前, 原路径在后」—— f[8] 是重命名后的新路径,
            //     下一个 NUL token 才是原路径。i += 1 消费原路径 token, 不消费会让
            //     后续条目全部错位 (-z 最容易踩的坑)。
            let f: Vec<&str> = rest.splitn(9, ' ').collect();
            if f.len() == 9 {
                let (staged, unstaged) = parse_xy(f[0]);
                let new_path = f[8].to_string();
                let old_path = tokens.get(i + 1).map(|s| s.to_string()).unwrap_or_default();
                i += 1; // 消费原路径 token
                files.push(GitFileChange { path: new_path, old_path: Some(old_path), staged, unstaged });
            }
        } else if let Some(rest) = tok.strip_prefix("u ") {
            // u <XY> <sub> <m1> <m2> <m3> <mw> <h1> <h2> <h3> <path>  (strip 前缀后 10 字段)
            let f: Vec<&str> = rest.splitn(10, ' ').collect();
            if f.len() == 10 {
                let (staged, unstaged) = parse_xy(f[0]);
                files.push(GitFileChange { path: f[9].to_string(), old_path: None, staged, unstaged });
            }
        } else if let Some(p) = tok.strip_prefix("? ") {
            // 未跟踪: 仅工作区, 暂存区无
            files.push(GitFileChange {
                path: p.to_string(),
                old_path: None,
                staged: None,
                unstaged: Some(GitChangeType::Untracked),
            });
        }
        // 其余头行 (# branch.oid 等) 忽略
        i += 1;
    }

    GitStatus { is_repo: true, branch, upstream, ahead, behind, files }
}

// --- commands ---

/// 仓库状态: 分支 / ahead-behind / 变更文件列表 (含暂存与工作区两侧语义状态)。
/// 非仓库目录 → Ok(is_repo=false) 安静降级; 未装 git → Err(中文提示)。
#[tauri::command]
pub fn git_status(cwd: String) -> Result<GitStatus, String> {
    match run_git(&cwd, &["status", "--porcelain=v2", "--branch", "-z"]) {
        Ok(out) => Ok(parse_status(&out)),
        Err(e) if e.contains("not a git repository") => {
            // 非仓库是正常状态 (大多数目录都不是 git 仓库), 不是错误
            Ok(GitStatus {
                is_repo: false,
                branch: None,
                upstream: None,
                ahead: None,
                behind: None,
                files: Vec::new(),
            })
        }
        Err(e) => Err(e),
    }
}

/// 变更 diff: 返回 unified patch 原文, 前端交给 DiffView 渲染 (与工具卡片 diff 同一组件)。
/// staged=true → `git diff --cached` (已暂存侧); false → `git diff` (未暂存侧)。
/// path=None → 全部改动; path=Some → 单文件。
#[tauri::command]
pub fn git_diff(cwd: String, path: Option<String>, staged: bool) -> Result<String, String> {
    let mut args: Vec<String> = vec!["diff".into()];
    if staged {
        args.push("--cached".into());
    }
    args.push("--".into());
    if let Some(p) = path {
        args.push(p);
    }
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git(&cwd, &refs)
}

/// 本地分支列表 (含当前标记与 upstream)
#[tauri::command]
pub fn git_branches(cwd: String) -> Result<Vec<GitBranch>, String> {
    // for-each-ref 比 `git branch --format` 更稳定; %(HEAD) 给当前分支标记 (* 或空)
    let out = run_git(&cwd, &[
        "for-each-ref",
        "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)",
        "refs/heads/",
    ])?;
    let mut branches = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.splitn(3, '\t').collect();
        if f.len() < 2 {
            continue;
        }
        branches.push(GitBranch {
            name: f[0].to_string(),
            current: f[1] == "*",
            upstream: f.get(2).filter(|s| !s.is_empty()).map(|s| s.to_string()),
        });
    }
    Ok(branches)
}

/// 提交历史 (作者/时间/主题/hash), limit 默认 100
#[tauri::command]
pub fn git_log(cwd: String, limit: Option<u32>) -> Result<Vec<GitLogEntry>, String> {
    let n = limit.unwrap_or(100);
    // %x09 = tab 分隔, 避免与 subject 里的空格冲突; %H 全 hash (git_show 需要完整 hash)
    let fmt = "%H%x09%an%x09%ad%x09%s";
    let out = run_git(&cwd, &["log", &format!("-n{n}"), &format!("--format={fmt}"), "--date=iso"])?;
    let mut entries = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.splitn(4, '\t').collect();
        if f.len() == 4 {
            entries.push(GitLogEntry {
                hash: f[0].to_string(),
                author: f[1].to_string(),
                date: f[2].to_string(),
                subject: f[3].to_string(),
            });
        }
    }
    Ok(entries)
}

/// 单个提交的元信息 + patch (unified diff 原文, 交给 DiffView)
#[tauri::command]
pub fn git_show(cwd: String, hash: String) -> Result<GitShowResult, String> {
    // --format 控制首行元信息, 其后跟 patch; 首个 \n 分割元信息行与 diff
    let out = run_git(&cwd, &["show", "--format=%H%x09%an%x09%ad%x09%s", "--date=iso", &hash])?;
    let mut parts = out.splitn(2, '\n');
    let meta = parts.next().unwrap_or("");
    let patch = parts.next().unwrap_or("").to_string();
    let f: Vec<&str> = meta.splitn(4, '\t').collect();
    if f.len() == 4 {
        Ok(GitShowResult {
            hash: f[0].to_string(),
            author: f[1].to_string(),
            date: f[2].to_string(),
            subject: f[3].to_string(),
            patch,
        })
    } else {
        Err(format!("解析 git show 输出失败: {meta}"))
    }
}

/// 暂存文件: `git add -- -- <paths>`。`--` 分隔符防 `-` 开头文件名被当选项 (git pathspec 语法)。
/// 支持多文件批量暂存。空路径是调用方误用, 直接返回明确错误而非让 git 报英文提示。
#[tauri::command]
pub fn git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("未指定要暂存的文件".into());
    }
    let mut args: Vec<String> = vec!["add".into(), "--".into()];
    args.extend(paths);
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git(&cwd, &refs)?;
    Ok(())
}

/// 取消暂存: `git restore --staged -- <paths>`。把文件移出暂存区, 工作区改动原样保留。
#[tauri::command]
pub fn git_unstage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("未指定要取消暂存的文件".into());
    }
    let mut args: Vec<String> = vec!["restore".into(), "--staged".into(), "--".into()];
    args.extend(paths);
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git(&cwd, &refs)?;
    Ok(())
}

/// 提交暂存区: `git commit -m <msg>`。写操作不可轻易回退, 前端需二次确认 (PRD R4)。
/// 失败 (如 pre-commit hook 拒绝) 的 stderr 由 run_git 原样上抛, 不截断 —— 用户需知道
/// 为什么提交失败 (design 风险条目), 吞掉错误会让用户以为提交成功。
#[tauri::command]
pub fn git_commit(cwd: String, message: String) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("提交信息不能为空".into());
    }
    run_git(&cwd, &["commit", "-m", &message])?;
    Ok(())
}

/// 切换分支: `git checkout <branch>`。工作区脏时 git 自身会拒绝并 stderr 提示哪些文件阻挡,
/// 前端在调用前预检查并明确告知后果, 不静默执行 (PRD R3)。分支名不以 `-` 开头 (git 规则),
/// 无需 `--` 分隔符 (checkout 的 `--` 后是 pathspec, 会把分支名当路径)。
#[tauri::command]
pub fn git_checkout(cwd: String, branch: String) -> Result<(), String> {
    run_git(&cwd, &["checkout", &branch])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_xy_basic() {
        assert_eq!(parse_xy(".."), (None, None));
        // 暂存修改 + 工作区无变更
        assert_eq!(parse_xy("M."), (Some(GitChangeType::Modified), None));
        // 暂存新增 + 工作区修改 (同文件两侧都有改动)
        assert_eq!(parse_xy("AM"), (Some(GitChangeType::Added), Some(GitChangeType::Modified)));
        // 删除 + 冲突
        assert_eq!(parse_xy("D."), (Some(GitChangeType::Deleted), None));
        assert_eq!(parse_xy("UU"), (Some(GitChangeType::Conflict), Some(GitChangeType::Conflict)));
    }

    #[test]
    fn parse_status_branch_and_files() {
        // 模拟 v2 -z 输出: 头行 + 普通修改 (工作区) + 未跟踪
        let raw = "# branch.head main\u{0}# branch.upstream origin/main\u{0}# branch.ab +2 -1\u{0}1 .M N... 100644 100644 100644 123 456 src/a.ts\u{0}? new.txt\u{0}";
        let s = parse_status(raw);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!(s.ahead, Some(2));
        assert_eq!(s.behind, Some(1));
        assert_eq!(s.files.len(), 2);
        assert_eq!(s.files[0].path, "src/a.ts");
        assert_eq!(s.files[0].staged, None);
        assert_eq!(s.files[0].unstaged, Some(GitChangeType::Modified));
        assert_eq!(s.files[1].path, "new.txt");
        assert_eq!(s.files[1].unstaged, Some(GitChangeType::Untracked));
    }

    #[test]
    fn parse_status_path_with_space() {
        // -z 模式 path 含空格安全: NUL 分隔, token 内空格原样保留
        let raw = "# branch.head main\u{0}1 .M N... 100644 100644 100644 123 456 src/my file.ts\u{0}";
        let s = parse_status(raw);
        assert_eq!(s.files[0].path, "src/my file.ts");
    }

    #[test]
    fn parse_status_rename_double_field_no_shift() {
        // 真实 v2 -z 重命名条目 (隔离仓库 `git mv 原文件.txt 新文件.txt` 实测输出):
        //   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <新路径>\0<原路径>\0
        // 两个反直觉点: (1) <hI> 后还有独立 <X><score> 字段 (R100), splitn 必须切 9 段,
        // 否则 score 粘进路径; (2) 顺序「新路径在前, 原路径在后」, 下一个 NUL token
        // 才是原路径。少消费那个 token 会让后续条目全部错位 —— -z 最容易踩的坑。
        let raw = "# branch.head main\u{0}2 R. N... 100644 100644 100644 94954abda49de8615a048f8d2e64b5de848e27a1 94954abda49de8615a048f8d2e64b5de848e27a1 R100 新文件.txt\u{0}原文件.txt\u{0}1 .M N... 100644 100644 100644 789 012 src/b.rs\u{0}";
        let s = parse_status(raw);
        assert_eq!(s.files.len(), 2);
        // 第一个: 重命名。path = 新路径, old_path = 原路径 (顺序反直觉: 新在前, 原在后)
        assert_eq!(s.files[0].path, "新文件.txt");
        assert_eq!(s.files[0].old_path.as_deref(), Some("原文件.txt"));
        assert_eq!(s.files[0].staged, Some(GitChangeType::Renamed));
        // 第二个: 普通修改, path=src/b.rs (没被重命名的原路径 token 错位吃掉)
        assert_eq!(s.files[1].path, "src/b.rs");
        assert_eq!(s.files[1].unstaged, Some(GitChangeType::Modified));
    }

    #[test]
    fn parse_status_empty_repo() {
        // 空 v2 输出 (刚 init 无提交): 只有 branch.head, 无文件
        let raw = "# branch.head main\u{0}";
        let s = parse_status(raw);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert!(s.files.is_empty());
        assert_eq!(s.ahead, None);
        assert_eq!(s.behind, None);
    }

    #[test]
    fn parse_status_detached_head() {
        // detached HEAD: branch.head = (detached), 无 upstream/ab 行
        let raw = "# branch.head (detached)\u{0}";
        let s = parse_status(raw);
        assert_eq!(s.branch.as_deref(), Some("(detached)"));
        assert_eq!(s.upstream, None);
    }

    /// 真实 git 集成验证: 依赖本机 git + 本仓库, 默认忽略
    #[test]
    #[ignore]
    fn git_status_real_repo() {
        let status = git_status(r"C:\workspace\hanjiang\pi-kitsune-desktop".to_string())
            .expect("git_status 应成功");
        assert!(status.is_repo);
        assert!(status.branch.is_some());
    }

    #[test]
    #[ignore]
    fn git_status_non_repo() {
        // 临时目录非 git 仓库 → is_repo=false, 不报错
        let status = git_status(std::env::temp_dir().to_string_lossy().to_string())
            .expect("非仓库应返回 Ok(is_repo=false), 不应 Err");
        assert!(!status.is_repo);
    }
}