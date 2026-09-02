import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readText, readImage } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Folder, MessageSquare, Sparkles, Clipboard, Camera,
  Loader2, AlertCircle, ClipboardPaste, ClipboardType, X, FilePlus2,
} from "lucide-react";
import type { Ref } from "../../lib/refs";
import { FileTreePicker } from "./FileTreePicker";
import { SessionPicker } from "./SessionPicker";
import { SkillPicker } from "./SkillPicker";

interface FileRef {
  kind: "image" | "text";
  fileName: string;
  data?: string;
  mimeType?: string;
  size?: number;
  lines?: number;
}

type TabKey = "file" | "session" | "skill" | "clipboard" | "shot";

const TABS: { key: TabKey; label: string; icon: typeof Folder }[] = [
  { key: "file", label: "文件", icon: Folder },
  { key: "session", label: "会话", icon: MessageSquare },
  { key: "skill", label: "技能", icon: Sparkles },
  { key: "clipboard", label: "剪贴板", icon: Clipboard },
  { key: "shot", label: "截图", icon: Camera },
];

// 上下文引用弹层: 多源 tabs, 选中后即时加入 (不关闭, 可连续添加), 点外部/完成关闭
export function RefsPopup({ root, onPick, onClose }: {
  root: string;
  onPick: (refs: Ref[]) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TabKey>("file");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // 剪贴板文本: 无路径可用 → 内联内容 (本质是用户要粘贴的内容)
  const pasteText = async () => {
    setBusy("clipboard-text");
    setErr(null);
    try {
      const text = await readText();
      if (!text.trim()) {
        setErr("剪贴板里没有文本");
        return;
      }
      onPick([{ kind: "clipboard-text", title: "剪贴板文本", content: text.slice(0, 4000) }]);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  // 剪贴板图片: RGBA → canvas 编码 PNG → ImageRef (Image 无公开宽高属性, 需 size() 查询)
  const pasteImage = async () => {
    setBusy("clipboard-image");
    setErr(null);
    try {
      const img = await readImage();
      const { width, height } = await img.size();
      const rgba = await img.rgba();
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas 不可用");
      const imageData = ctx.createImageData(width, height);
      imageData.data.set(rgba);
      ctx.putImageData(imageData, 0, 0);
      onPick([{
        kind: "clipboard-image",
        title: "剪贴板图片",
        data: canvas.toDataURL("image/png").split(",")[1],
        mimeType: "image/png",
      }]);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  // 全屏截图: Rust xcap 捕获 → base64 (走 images 字段)
  const shoot = async () => {
    setBusy("shot");
    setErr(null);
    try {
      const res = await invoke<{ data: string; mimeType: string }>("capture_screenshot");
      onPick([{ kind: "screenshot", title: "屏幕截图", data: res.data, mimeType: res.mimeType }]);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  // 系统选择器引用任意文件: 图片 → base64; 文本 → 路径模式
  const addAnyFile = async () => {
    setErr(null);
    try {
      const sel = await open({ multiple: false, title: "引用文件" });
      if (!sel || typeof sel !== "string") return;
      const res = await invoke<FileRef>("read_file_for_context", { filePath: sel });
      if (res.kind === "image" && res.data && res.mimeType) {
        onPick([{ kind: "image", title: res.fileName, data: res.data, mimeType: res.mimeType }]);
      } else {
        onPick([{
          kind: "file",
          title: res.fileName,
          path: sel,
          meta: { size: res.size ?? undefined, lines: res.lines ?? undefined },
        }]);
      }
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div className="absolute bottom-full left-0 z-50 mb-1 w-[520px] rounded-md border border-neutral-200 bg-panel p-3 shadow-lg">
      {/* tabs */}
      <div className="mb-2 flex items-center gap-1 border-b border-neutral-100 pb-2">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => { setTab(key); setErr(null); }}
            className={`flex items-center gap-1 rounded-md px-2 py-2 text-xs transition duration-fast ease-out ${
              tab === key
                ? "bg-primary-50 font-medium text-primary-600"
                : "text-neutral-500 hover:bg-neutral-100"
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
        <button
          onClick={onClose}
          className="ml-auto rounded-md p-2 text-neutral-400 transition duration-fast ease-out hover:bg-neutral-100"
          title="完成"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {tab === "file" && (
        <div className="flex flex-col gap-2">
          <FileTreePicker root={root} onPick={onPick} onDone={() => {}} />
          <button
            onClick={addAnyFile}
            className="flex items-center justify-center gap-2 rounded-md border border-dashed border-neutral-300 px-3 py-2 text-xs text-neutral-500 transition duration-fast ease-out hover:border-primary-300 hover:text-primary-600"
          >
            <FilePlus2 className="h-4 w-4" />
            引用项目外文件 (系统选择器)
          </button>
        </div>
      )}
      {tab === "session" && (
        <SessionPicker onPick={onPick} onDone={() => {}} />
      )}
      {tab === "skill" && (
        <SkillPicker onPick={onPick} onDone={() => {}} />
      )}
      {tab === "clipboard" && (
        <div className="flex h-72 flex-col items-start justify-center gap-3 px-6">
          <button
            onClick={pasteText}
            disabled={busy !== null}
            className="flex w-full items-center gap-2 rounded-md border border-neutral-200 px-4 py-3 text-left text-sm text-neutral-700 transition duration-fast ease-out hover:border-primary-300 hover:bg-primary-50 disabled:opacity-50"
          >
            {busy === "clipboard-text" ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary-500" />
            ) : (
              <ClipboardPaste className="h-4 w-4 text-primary-500" />
            )}
            粘贴剪贴板文本
          </button>
          <button
            onClick={pasteImage}
            disabled={busy !== null}
            className="flex w-full items-center gap-2 rounded-md border border-neutral-200 px-4 py-3 text-left text-sm text-neutral-700 transition duration-fast ease-out hover:border-primary-300 hover:bg-primary-50 disabled:opacity-50"
          >
            {busy === "clipboard-image" ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary-500" />
            ) : (
              <ClipboardType className="h-4 w-4 text-primary-500" />
            )}
            粘贴剪贴板图片
          </button>
        </div>
      )}
      {tab === "shot" && (
        <div className="flex h-72 flex-col items-start justify-center gap-3 px-6">
          <button
            onClick={shoot}
            disabled={busy !== null}
            className="flex w-full items-center gap-2 rounded-md border border-neutral-200 px-4 py-3 text-left text-sm text-neutral-700 transition duration-fast ease-out hover:border-primary-300 hover:bg-primary-50 disabled:opacity-50"
          >
            {busy === "shot" ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary-500" />
            ) : (
              <Camera className="h-4 w-4 text-primary-500" />
            )}
            截取屏幕 (全屏)
          </button>
          <p className="text-xs text-neutral-400">截图随消息以图片形式发送, 视觉模型可直接查看</p>
        </div>
      )}

      {err && (
        <p className="mt-2 flex items-center gap-1 text-xs text-red-500">
          <AlertCircle className="h-3 w-3" />
          {err}
        </p>
      )}
    </div>
  );
}
