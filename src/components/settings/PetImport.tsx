import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { CircleCheck, CircleX, FileArchive, FolderOpen, LoaderCircle, TriangleAlert } from "lucide-react";
import { usePetStore, type PetTier } from "../../store/pet";
import { Badge, Button, Card } from "../ui";

/** Rust 侧 pet_import.rs 的 ImportReport */
interface ImportIssue {
  action: string | null;
  file: string | null;
  message: string;
}
interface ImportReport {
  token: string;
  id: string;
  name: string;
  frame_width: number;
  frame_height: number;
  exists: boolean;
  existing_dir: string | null;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  tier: PetTier;
  missing: string[];
  previews: { action: string; data_uri: string; durations: number[] }[];
}

// 宠物包档位: 只有 idle 是必选, 动作类别越全宠物越生动 (见 pets.rs BASIC / FULL)
export const TIER_LABEL: Record<PetTier, string> = { required: "必选档", basic: "基础档", full: "完整档" };
/** 预览格边长: 帧按比例缩进这个方框 */
const PREVIEW_BOX = 72;

/** 规整后的横条图循环播放; 按逐帧时长用定时器推进, 与桌宠窗口同一口径 */
function ActionPreview({ uri, durations, fw, fh }: { uri: string; durations: number[]; fw: number; fh: number }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = window.setTimeout(() => setFrame((f) => (f + 1) % durations.length), durations[frame]);
    return () => window.clearTimeout(t);
  }, [frame, durations]);
  const scale = Math.min(PREVIEW_BOX / fw, PREVIEW_BOX / fh);
  return (
    <div
      className="mx-auto"
      style={{
        width: fw * scale,
        height: fh * scale,
        backgroundImage: `url("${uri}")`,
        backgroundSize: `${durations.length * fw * scale}px ${fh * scale}px`,
        backgroundPosition: `${-frame * fw * scale}px 0`,
        backgroundRepeat: "no-repeat",
        imageRendering: "pixelated",
      }}
    />
  );
}

function IssueRow({ issue, kind }: { issue: ImportIssue; kind: "error" | "warn" }) {
  const where = [issue.action, issue.file].filter(Boolean).join(" · ");
  const Icon = kind === "error" ? CircleX : TriangleAlert;
  return (
    <li className="flex items-start gap-2 text-label">
      <Icon
        className={`mt-[3px] h-3 w-3 shrink-0 ${kind === "error" ? "text-err" : "text-warn"}`}
      />
      <span className="text-fg-2">
        {where && <span className="mr-1 font-mono text-fg-3">{where}</span>}
        {issue.message}
      </span>
    </li>
  );
}

// 宠物包导入: 选 zip / 文件夹 → Rust 规整并回报 (错误 / 警告 / 动作预览) → 确认后落盘
export function PetImport() {
  const loadPets = usePetStore((s) => s.loadPets);
  const setPetId = usePetStore((s) => s.setPetId);
  const [busy, setBusy] = useState<"inspect" | "commit" | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // 面板关掉时还挂着的导入要清掉缓存; 用 ref 是因为卸载时拿不到最新 state
  const pendingRef = useRef<string | null>(null);
  pendingRef.current = report?.token ?? null;
  useEffect(
    () => () => {
      if (pendingRef.current) void invoke("discard_pet_import", { token: pendingRef.current }).catch(() => {});
    },
    [],
  );

  const discard = () => {
    if (report) void invoke("discard_pet_import", { token: report.token }).catch(() => {});
    setReport(null);
  };

  const pick = async (kind: "zip" | "dir") => {
    // dialog 不能同时选文件和目录, 所以分成两个入口
    const sel = await open(
      kind === "dir"
        ? { directory: true, multiple: false, title: "选择宠物包文件夹" }
        : { multiple: false, title: "选择宠物包 zip", filters: [{ name: "宠物包", extensions: ["zip"] }] },
    );
    if (typeof sel !== "string") return;
    discard();
    setFailure(null);
    setDone(null);
    setBusy("inspect");
    try {
      setReport(await invoke<ImportReport>("inspect_pet_import", { path: sel }));
    } catch (e) {
      setFailure(String(e));
    } finally {
      setBusy(null);
    }
  };

  const commit = async () => {
    if (!report) return;
    setBusy("commit");
    try {
      const id = await invoke<string>("commit_pet_import", { token: report.token, overwrite: report.exists });
      setReport(null);
      setDone(`已导入「${report.name || id}」`);
      await loadPets();
      setPetId(id);
    } catch (e) {
      setFailure(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy !== null} onClick={() => void pick("zip")}>
          <FileArchive className="h-4 w-4" />
          导入 zip
        </Button>
        <Button disabled={busy !== null} onClick={() => void pick("dir")}>
          <FolderOpen className="h-4 w-4" />
          导入文件夹
        </Button>
        {busy === "inspect" && (
          <span className="flex items-center gap-2 text-label text-fg-3">
            <LoaderCircle className="h-[14px] w-[14px] animate-spin" />
            正在切帧、对齐…
          </span>
        )}
      </div>

      {failure && (
        <p className="mt-3 flex items-start gap-2 text-label text-err">
          <CircleX className="mt-[3px] h-3 w-3 shrink-0" />
          {failure}
        </p>
      )}
      {done && (
        <p className="mt-3 flex items-center gap-2 text-label text-ok">
          <CircleCheck className="h-3 w-3 shrink-0" />
          {done}
        </p>
      )}

      {report && (
        <Card padded className="mt-4">
          <div className="flex items-center gap-2">
            <span className="truncate text-lead font-semibold text-fg">{report.name || report.id}</span>
            <span className="font-mono text-label text-fg-4">{report.id}</span>
            <Badge className="ml-auto">{TIER_LABEL[report.tier]}</Badge>
          </div>
          {report.missing.length > 0 && (
            <p className="mt-1 text-label text-fg-4">缺：{report.missing.join("、")}</p>
          )}

          {report.exists && report.errors.length === 0 && (
            <p className="mt-3 flex items-start gap-2 text-label text-warn">
              <TriangleAlert className="mt-[3px] h-3 w-3 shrink-0" />
              <span>
                已有同 id 的宠物包，导入会替换
                <span className="ml-1 break-all font-mono">{report.existing_dir}</span>
              </span>
            </p>
          )}

          {(report.errors.length > 0 || report.warnings.length > 0) && (
            <ul className="mt-3 space-y-2">
              {report.errors.map((e, i) => (
                <IssueRow key={`e${i}`} issue={e} kind="error" />
              ))}
              {report.warnings.map((w, i) => (
                <IssueRow key={`w${i}`} issue={w} kind="warn" />
              ))}
            </ul>
          )}

          {report.previews.length > 0 && (
            <div className="mt-4 grid grid-cols-4 gap-2">
              {report.previews.map((p) => (
                <figure
                  key={p.action}
                  className="rounded-md border border-line p-2"
                  // 棋盘格底: 一眼看出哪里是透明的, 抠图残留的底色也藏不住
                  style={{
                    backgroundImage:
                      "conic-gradient(var(--line) 25%, transparent 0 50%, var(--line) 0 75%, transparent 0)",
                    backgroundSize: "12px 12px",
                  }}
                >
                  <ActionPreview
                    uri={p.data_uri}
                    durations={p.durations}
                    fw={report.frame_width}
                    fh={report.frame_height}
                  />
                  <figcaption className="mt-1 truncate text-center font-mono text-label text-fg-3">
                    {p.action}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Button disabled={busy !== null} onClick={discard}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={busy !== null || report.errors.length > 0}
              title={report.errors.length > 0 ? "先修好上面的错误再导入" : undefined}
              onClick={() => void commit()}
            >
              {busy === "commit" && <LoaderCircle className="h-4 w-4 animate-spin" />}
              {report.exists ? "覆盖导入" : "导入"}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
