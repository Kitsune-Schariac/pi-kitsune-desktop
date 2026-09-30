import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleAlert, CircleCheck, FileJson, Info, LoaderCircle, Plus, RefreshCw, Save, Undo2, X } from "lucide-react";
import {
  changedProviderIds,
  deletedProviderCount,
  modelOf,
  modelsOf,
  sameDefaults,
  useModelsConfigStore,
} from "../../store/modelsConfig";
import { Button } from "../ui";
import { DefaultsBar } from "./models/DefaultsBar";
import { EditorPlaceholder, ModelEditor, type EditorMode } from "./models/ModelEditor";
import { ProviderList } from "./models/ProviderList";
import { ProviderPane } from "./models/ProviderPane";
import { Badge, useElementWidth } from "./models/shared";

// 设置窗「模型与供应商」tab: 直接编辑 pi 的 models.json, 外加 settings.json 的新会话默认三键。
// 三栏: 供应商列表 / 选中供应商的连接与模型列表 / 选中模型的编辑器; 面板自身宽度 < 960 时
// 退成两栏 (编辑器顶替模型列表, 可返回)。整份文档在 store 里以普通对象承载, 组件只做定点赋值。
//
// 外壳契约: SettingsWindow 把本组件直接塞进 `flex-1 min-h-0 overflow-hidden` 容器, 不套
// padding 也不套滚动容器 —— 根节点必须自己撑满高度并各自管理滚动, 否则全高布局会塌。
export function ModelsPanel() {
  const doc = useModelsConfigStore((s) => s.doc);
  const docBase = useModelsConfigStore((s) => s.docBase);
  const path = useModelsConfigStore((s) => s.path);
  const parseError = useModelsConfigStore((s) => s.parseError);
  const dirty = useModelsConfigStore((s) => s.dirty);
  const defaults = useModelsConfigStore((s) => s.defaults);
  const defaultsBase = useModelsConfigStore((s) => s.defaultsBase);
  const selectedProvider = useModelsConfigStore((s) => s.selectedProvider);
  const selectedModelId = useModelsConfigStore((s) => s.selectedModelId);
  const saveError = useModelsConfigStore((s) => s.saveError);
  const notice = useModelsConfigStore((s) => s.notice);
  const undo = useModelsConfigStore((s) => s.undo);
  const loading = useModelsConfigStore((s) => s.loading);
  const loaded = useModelsConfigStore((s) => s.loaded);
  const saving = useModelsConfigStore((s) => s.saving);

  const load = useModelsConfigStore((s) => s.load);
  const reload = useModelsConfigStore((s) => s.reload);
  const save = useModelsConfigStore((s) => s.save);
  const dismissNotice = useModelsConfigStore((s) => s.dismissNotice);
  const resetTransient = useModelsConfigStore((s) => s.resetTransient);
  const createInitialDoc = useModelsConfigStore((s) => s.createInitialDoc);
  const undoLast = useModelsConfigStore((s) => s.undoLast);
  const dismissUndo = useModelsConfigStore((s) => s.dismissUndo);

  // 面板每次挂载 (切进该 tab) 拉一次快照, 拿新 mtime 续乐观锁。
  // 已有未保存改动时 store 会跳过这次自动加载 —— 切走 tab 会卸载面板, 重载等于无声丢改动。
  // 测试结果与撤销只在本次打开面板期间有意义, 卸载时清掉
  useEffect(() => {
    void load();
    return () => resetTransient();
  }, [load, resetTransient]);

  const rootRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(rootRef);
  const narrow = width > 0 && width < 960;
  const [narrowView, setNarrowView] = useState<"list" | "editor">("list");
  const [mode, setMode] = useState<EditorMode>("form");
  const [adding, setAdding] = useState(false);
  const [reloadArmed, setReloadArmed] = useState(false);

  // 非法 JSON 槽位 (高级区 JSON 字段 + 模型 JSON 模式): 非空即禁用保存
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});
  const setJsonError = useCallback((key: string, msg: string | null) => {
    setJsonErrors((prev) => {
      if (msg === null) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return prev[key] === msg ? prev : { ...prev, [key]: msg };
    });
  }, []);
  const hasJsonError = Object.keys(jsonErrors).length > 0;

  useEffect(() => {
    setAdding(false);
    setNarrowView("list");
  }, [selectedProvider]);
  useEffect(() => {
    if (!selectedModelId) setNarrowView("list");
  }, [selectedModelId]);
  // 「重新加载」二次确认: 按钮原地变文案, 3 秒内不再点就复位
  useEffect(() => {
    if (!reloadArmed) return;
    const t = setTimeout(() => setReloadArmed(false), 3000);
    return () => clearTimeout(t);
  }, [reloadArmed]);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(dismissUndo, 6000);
    return () => clearTimeout(t);
  }, [undo, dismissUndo]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(dismissNotice, 5000);
    return () => clearTimeout(t);
  }, [notice, dismissNotice]);

  // 「N 处未保存」= 有改动的供应商 + 被删的供应商 + 默认值是否改过
  const changed = useMemo(() => changedProviderIds(doc, docBase), [doc, docBase]);
  const deleted = useMemo(() => deletedProviderCount(doc, docBase), [doc, docBase]);
  const defaultsChanged = !!defaults && !!defaultsBase && !sameDefaults(defaults, defaultsBase);
  let pending = changed.size + deleted + (defaultsChanged ? 1 : 0);
  // 只改了顶层键序 / 从零新建文档时按供应商数不出来, 但确实有东西要写
  if (dirty && changed.size + deleted === 0) pending += 1;

  const onReload = () => {
    if (pending > 0 && !reloadArmed) {
      setReloadArmed(true);
      return;
    }
    setReloadArmed(false);
    setMode("form");
    void reload();
  };

  const isConflict = !!saveError && saveError.includes("冲突");
  const model = modelOf(doc, selectedProvider, selectedModelId);
  const editor =
    selectedProvider && selectedModelId && model ? (
      <ModelEditor
        key={`${selectedProvider}|${selectedModelId}`}
        pid={selectedProvider}
        mid={selectedModelId}
        mode={mode}
        onModeChange={setMode}
        onBack={narrow ? () => setNarrowView("list") : undefined}
        onJsonError={setJsonError}
      />
    ) : selectedProvider ? (
      <EditorPlaceholder
        pid={selectedProvider}
        hasModels={modelsOf(doc, selectedProvider).length > 0}
        onAdd={() => setAdding(true)}
      />
    ) : (
      <section />
    );
  const pane = (
    <ProviderPane
      adding={adding}
      onAddingChange={setAdding}
      onOpenModel={() => {
        if (narrow) setNarrowView("editor");
      }}
      onJsonError={setJsonError}
    />
  );

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[var(--line)] pl-6 pr-4">
        <div className="flex min-w-0 items-center gap-2">
          <FileJson className="h-4 w-4 shrink-0 text-[var(--fg-4)]" />
          <span className="truncate font-mono text-label text-[var(--fg-3)]" title={path || undefined}>
            {path || "~/.pi/agent/models.json"}
          </span>
          {parseError ? (
            <Badge tone="err">
              <CircleAlert className="h-3 w-3" />
              文件损坏
            </Badge>
          ) : pending > 0 ? (
            <Badge tone="warn">{pending} 处未保存</Badge>
          ) : doc ? (
            <Badge>
              <Check className="h-3 w-3" />
              已保存
            </Badge>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant={reloadArmed ? "danger" : "ghost"}
            disabled={loading}
            onClick={onReload}
            title="重新读取 models.json 与 settings.json"
          >
            <RefreshCw className={`h-[14px] w-[14px] ${loading ? "animate-spin" : ""}`} />
            {reloadArmed ? "再点一次放弃改动" : "重新加载"}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!pending || saving || hasJsonError}
            title={hasJsonError ? "有 JSON 没通过校验, 修正后才能保存" : undefined}
            onClick={() => void save()}
          >
            <Save className="h-[14px] w-[14px]" />
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </header>

      {saveError && (
        <div className="flex shrink-0 items-start gap-2 border-b border-[var(--line)] bg-[var(--well)] px-6 py-2 text-label text-[var(--err)]">
          <CircleAlert className="mt-[2px] h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="break-all">{saveError}</p>
            {isConflict && (
              <Button size="sm" variant="danger" className="mt-2" onClick={() => void reload()}>
                <RefreshCw className="h-3 w-3" />
                放弃本地改动并重新加载
              </Button>
            )}
          </div>
        </div>
      )}

      {loaded && <DefaultsBar />}

      {loading && !loaded ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-label text-[var(--fg-3)]">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          正在读取配置…
        </div>
      ) : parseError ? (
        // 文件存在但 JSON 非法: 展示明确错误并禁用全部写操作。
        // 绝不能以空配置覆盖用户的坏文件 —— 那份文件里可能有 GUI 看不懂但 pi 认的配置。
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-2xl">
            <div className="flex items-start gap-2 rounded-lg border border-[var(--err)] bg-[var(--raise)] p-4">
              <CircleAlert className="mt-[2px] h-4 w-4 shrink-0 text-[var(--err)]" />
              <div className="min-w-0 space-y-2">
                <p className="text-body font-semibold text-[var(--err)]">models.json 无法解析, 已禁用全部编辑</p>
                <p className="break-all font-mono text-label text-[var(--err)]">{parseError}</p>
                <p className="text-label leading-relaxed text-[var(--fg-3)]">
                  请在外部编辑器修复后点击「重新加载」。为保护你的配置, 此状态下不会覆盖原文件。
                </p>
              </div>
            </div>
            <p className="mt-3 break-all font-mono text-label text-[var(--fg-3)]">{path}</p>
          </div>
        </div>
      ) : !doc ? (
        loaded && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <FileJson className="h-8 w-8 text-[var(--fg-4)]" />
            <div>
              <p className="text-body text-[var(--fg-2)]">尚未创建 models.json</p>
              <p className="mt-1 break-all font-mono text-label text-[var(--fg-3)]">{path}</p>
            </div>
            <Button variant="primary" onClick={createInitialDoc}>
              <Plus className="h-4 w-4" />
              创建初始配置
            </Button>
          </div>
        )
      ) : (
        <div
          className={`grid min-h-0 flex-1 ${
            narrow ? "grid-cols-[240px_minmax(0,1fr)]" : "grid-cols-[240px_320px_minmax(0,1fr)]"
          }`}
        >
          <ProviderList />
          {narrow ? (narrowView === "editor" && model ? editor : pane) : (
            <>
              {pane}
              {editor}
            </>
          )}
        </div>
      )}

      {(undo || notice) && (
        <div
          role="status"
          className="view-in-soft absolute bottom-7 left-1/2 z-[60] flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-3 rounded-lg border border-[var(--line-2)] bg-[var(--popover)] py-2 pl-4 pr-2 text-body text-[var(--fg)] shadow-[var(--shadow)]"
        >
          {undo ? (
            <>
              <Info className="h-4 w-4 shrink-0 text-[var(--fg-3)]" />
              <span className="min-w-0 truncate">{undo.label}, 保存前都能撤销</span>
              <button
                onClick={undoLast}
                className="inline-flex shrink-0 items-center gap-1 text-label text-[var(--accent)] underline-offset-[3px] hover:underline"
              >
                <Undo2 className="h-3 w-3" />
                撤销删除
              </button>
            </>
          ) : (
            <>
              <CircleCheck className="h-4 w-4 shrink-0 text-[var(--ok)]" />
              <span className="min-w-0 truncate" title={notice ?? undefined}>
                {notice}
              </span>
            </>
          )}
          <button
            onClick={undo ? dismissUndo : dismissNotice}
            title="关闭"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-sm text-[var(--fg-3)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
          >
            <X className="h-[14px] w-[14px]" />
          </button>
        </div>
      )}
    </div>
  );
}
