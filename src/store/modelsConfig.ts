// models.json 配置面板 store (设置窗「模型与供应商」tab): 整份文档的本地编辑态 + 保存,
// 外加 settings.json 的新会话默认三键、测试连接结果、删除撤销。
//
// ## 为什么文档用 Record<string, unknown> 承载, 而不是穷举字段的 interface
// pi 的 `compat` 有 20+ 个兼容性开关且随 pi 版本演进 (thinkingFormat 一个枚举就十余个
// 取值)。任何「定义 full interface → 反序列化 → 重建对象 → 序列化」的写法, 都会让本版本
// 不认识的键在保存时静默消失 —— 用户升级 pi 后新加的配置被 GUI 一次保存抹掉, 这不是
// 边缘情况而是必然发生的数据损坏。因此这里的每个编辑动作都只替换路径上的对象, 兄弟键
// 原样引用, 绝不重建整棵树; 后端同理 (models_config.rs 用 serde_json::Value 承载)。
//
// ## 乐观锁
// mtimeMs 是读取时拿到的文件 mtime, 保存时作为 expectedMtimeMs 回传。面板打开期间外部
// 改动了文件 (编辑器手改 / pi 自身写入) → 后端拒绝写并返回含「mtime 冲突」的错误,
// 前端提示重新加载, 由用户决定是否放弃本地改动 —— 绝不覆盖外部改动。
// settings.json 不走 mtime (pi 频繁写它), 而是按三键比对 defaultsBase, 见 settings_config.rs。
//
// ## parseError 的闸门作用
// 文件存在但 JSON 非法时 raw 为 null。此时 doc 为 null, 所有编辑动作无处下手; save()
// 也直接拒绝。以空配置覆盖用户的坏文件是最糟的结局, 必须堵死。
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type JsonObject = Record<string, unknown>;

// Rust 侧字段 snake_case 原样透传 (未加 serde rename_all), 前端类型必须对齐下划线字段
interface ModelsConfigSnapshot {
  path: string;
  exists: boolean;
  raw: JsonObject | null;
  parse_error: string | null;
  mtime_ms: number;
}

interface WriteResult {
  mtime_ms: number;
  backup_path: string | null;
}

/** settings.json 的新会话默认三键; 缺失的键为空串 (settings_config.rs SessionDefaults) */
export interface SessionDefaults {
  provider: string;
  model: string;
  thinking: string;
}

interface SettingsDefaultsSnapshot {
  path: string;
  exists: boolean;
  parse_error: string | null;
  defaults: SessionDefaults;
}

/** 测试连接结果 (provider_probe.rs ProbeResult); 预期内的失败也走这里, ok=false + error_kind */
export interface ProbeResult {
  ok: boolean;
  url: string;
  status: number | null;
  elapsed_ms: number;
  models: string[];
  /** unsupported_api / invalid_url / no_key / unsupported_key / invalid_header / http / timeout / connect / parse; 前端补充 internal */
  error_kind: string | null;
  message: string | null;
}

export type ProbeState = { status: "running"; url: string } | { status: "done"; result: ProbeResult };

/** 单级撤销快照: 只给删除用, 恢复的是删除前的整份状态 */
export interface UndoEntry {
  label: string;
  /** 每次新删除递增, 提示条据此重置倒计时 */
  seq: number;
  doc: JsonObject;
  defaults: SessionDefaults | null;
  selectedProvider: string | null;
  selectedModelId: string | null;
}

export const isObj = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** cost 四主键: pi 启动校验要求存在 cost 时四键齐全 (实测默认值全零) */
export const COST_MAIN_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** 思考等级档位: pi 固定 7 档 (docs/models.md Thinking Level Map) */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** compat 专用开关 (模型级只做这两个, 其余 compat 键走 JSON 模式) */
export const COMPAT_FLAGS = ["supportsDeveloperRole", "supportsReasoningEffort"] as const;

/** 顶层 providers 映射; 缺失或非对象一律当作空映射, 面板照常渲染 */
export function providersOf(doc: JsonObject | null): JsonObject {
  const p = doc?.providers;
  return isObj(p) ? p : {};
}

export function providerIds(doc: JsonObject | null): string[] {
  return Object.keys(providersOf(doc));
}

/** 单个 provider 配置; 坏配置 (非对象) 返回空对象而不是抛错, 避免整个面板崩掉 */
export function providerOf(doc: JsonObject | null, pid: string | null): JsonObject {
  if (!doc || !pid) return {};
  const v = providersOf(doc)[pid];
  return isObj(v) ? v : {};
}

/**
 * models[] 的原文数组, 不过滤任何元素。
 * 增 / 删 / 列表渲染必须走这里: modelsOf 的过滤只用于「按 id 找对象模型」, 拿它做写入
 * 会把用户手写的非对象项 (字符串 / null / 数字) 静默抹掉 —— 那些项虽然非法 (后端校验会拒),
 * 但它们是用户数据, 该由用户在 UI 里看见并决定删不删, 而不是被一次无关编辑悄悄清掉。
 */
export function rawModelsOf(doc: JsonObject | null, pid: string | null): unknown[] {
  const models = providerOf(doc, pid).models;
  return Array.isArray(models) ? models : [];
}

/** provider 的自定义模型数组 (对应 models[]), 只保留对象项; 非数组视为空 */
export function modelsOf(doc: JsonObject | null, pid: string | null): JsonObject[] {
  return rawModelsOf(doc, pid).filter(isObj);
}

export function modelOf(doc: JsonObject | null, pid: string | null, mid: string | null): JsonObject | null {
  if (!mid) return null;
  return modelsOf(doc, pid).find((m) => m.id === mid) ?? null;
}

/** 供应商下第一个可选中的模型 id (id 必须是字符串才能被选中与定位) */
function firstModelId(doc: JsonObject | null, pid: string | null): string | null {
  const m = modelsOf(doc, pid).find((x) => typeof x.id === "string");
  return (m?.id as string | undefined) ?? null;
}

/**
 * 其他供应商里的同名定义 (新增 / 拉取模型时沿用参数用)。多个供应商都有时取字段最多的那份:
 * 字段越全, 越可能是认真配过 cost / thinkingLevelMap 的那份, 而不是随手只写了 id 的。
 */
export function findModelSource(
  doc: JsonObject | null,
  id: string,
  exceptPid: string | null,
): { pid: string; model: JsonObject } | null {
  let best: { pid: string; model: JsonObject } | null = null;
  for (const pid of providerIds(doc)) {
    if (pid === exceptPid) continue;
    const m = modelsOf(doc, pid).find((x) => x.id === id);
    if (m && (!best || Object.keys(m).length > Object.keys(best.model).length)) best = { pid, model: m };
  }
  return best;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const sameDefaults = (a: SessionDefaults | null, b: SessionDefaults | null) =>
  !!a && !!b && a.provider === b.provider && a.model === b.model && a.thinking === b.thinking;

/** 与加载快照相比有改动的 provider (含新增); 列表圆点与「N 处未保存」共用 */
export function changedProviderIds(doc: JsonObject | null, base: JsonObject | null): Set<string> {
  const baseProviders = providersOf(base);
  const out = new Set<string>();
  for (const [pid, p] of Object.entries(providersOf(doc))) {
    if (!sameJson(p, baseProviders[pid])) out.add(pid);
  }
  return out;
}

export function deletedProviderCount(doc: JsonObject | null, base: JsonObject | null): number {
  const now = providersOf(doc);
  return providerIds(base).filter((pid) => !(pid in now)).length;
}

/** 模型行的未保存圆点: 快照里同 provider 下没有同 id 模型, 或内容不同 */
export function isModelChanged(base: JsonObject | null, pid: string, model: JsonObject): boolean {
  const old = modelsOf(base, pid).find((m) => m.id === model.id);
  return !old || !sameJson(old, model);
}

// 值为 null / undefined / 空字符串 → 删除该键: pi 侧「未设置」就是缺省, 存空串会让 pi 拿到空 baseUrl
function putKey(obj: JsonObject, key: string, value: unknown): JsonObject {
  const next = { ...obj };
  if (value === null || value === undefined || value === "") delete next[key];
  else next[key] = value;
  return next;
}

// 不可变定位更新: 只克隆路径上的对象, 兄弟键保持引用 (保真约束的实现方式)
function withProvider(
  doc: JsonObject,
  pid: string,
  fn: (p: JsonObject) => JsonObject,
): JsonObject {
  return { ...doc, providers: { ...providersOf(doc), [pid]: fn(providerOf(doc, pid)) } };
}

// 按 id 定位模型后重写数组; 非对象项原样保留 (后端校验会拒, 但前端不擅自丢弃用户数据)
function withModel(
  doc: JsonObject,
  pid: string,
  mid: string,
  fn: (m: JsonObject) => JsonObject,
): JsonObject {
  return withProvider(doc, pid, (p) => {
    const raw = Array.isArray(p.models) ? p.models : [];
    return { ...p, models: raw.map((m) => (isObj(m) && m.id === mid ? fn(m) : m)) };
  });
}

/** 在指定键之后插入新键, 其余键序不变 (复制供应商时让副本紧挨原件) */
function insertAfter(obj: JsonObject, afterKey: string, key: string, value: unknown): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v;
    if (k === afterKey) out[key] = value;
  }
  if (!(key in out)) out[key] = value;
  return out;
}

/** 生成不与现有 id 冲突的新条目 id (x-copy / x-copy-2 ...) */
function uniqueId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; ; i++) {
    const cand = `${base}-${i}`;
    if (!taken(cand)) return cand;
  }
}

// JSON 模式有未应用草稿时, 切换选中项前要先让编辑器校验并应用; 失败返回 false 阻止切走。
// 选中项切换发生在列表组件里, 草稿在编辑器组件里, 两者只在 store 的选择动作处交汇
let leaveGuard: (() => boolean) | null = null;
export function setLeaveGuard(fn: (() => boolean) | null) {
  leaveGuard = fn;
}
const canLeave = () => (leaveGuard ? leaveGuard() : true);

// 加载快照的序列化缓存: dirty 在每次编辑时都要比对, 不必每次重算基线那一半
let baseJson = "null";
let undoSeq = 0;

export interface ModelsConfigStore {
  /** 整份文档, 编辑的唯一真相; null = 文件不存在或 JSON 非法 */
  doc: JsonObject | null;
  /** 最近一次加载 / 保存时的文档, dirty 与「N 处未保存」的比对基线 */
  docBase: JsonObject | null;
  path: string;
  exists: boolean;
  mtimeMs: number;
  parseError: string | null;
  /** models.json 是否有未保存改动 (doc 与 docBase 不同) */
  dirty: boolean;

  /** 新会话默认的编辑态; null = settings.json 读取失败 */
  defaults: SessionDefaults | null;
  /** 加载时读到的值: 写入时作为冲突检测的 expected, 也是 dirty 判断基线 */
  defaultsBase: SessionDefaults | null;
  settingsPath: string;
  /** settings.json 损坏 / 读取失败 → 默认条只读 */
  settingsParseError: string | null;

  selectedProvider: string | null;
  selectedModelId: string | null;
  saveError: string | null;
  /** 正向提示 (保存成功的生效说明 / 批量添加结果); 任何编辑都会清掉它 */
  notice: string | null;
  loading: boolean;
  saving: boolean;
  /** 是否已成功加载过一次; 面板据此区分「首次打开」与「切走 tab 又切回」 */
  loaded: boolean;

  /** 测试连接状态, key = provider id; 不持久化, 不计入 dirty */
  probes: Record<string, ProbeState>;
  undo: UndoEntry | null;

  /**
   * 拉取快照。force=false (默认) 时若已加载过且存在未保存改动, 直接返回 —— 面板每次挂载
   * 都会调用它, 而切走 tab 会卸载面板, 无保护的重载等于静默丢弃用户改动。
   */
  load: (opts?: { force?: boolean }) => Promise<void>;
  reload: () => Promise<void>;
  /** 两个文件哪个有改动写哪个, 各自独立成败 */
  save: () => Promise<void>;
  dismissNotice: () => void;
  notify: (text: string) => void;
  /** 面板卸载时清掉测试结果与撤销 (它们只在本次打开面板期间有意义) */
  resetTransient: () => void;

  selectProvider: (pid: string | null) => void;
  selectModel: (mid: string | null) => void;
  /** 文件不存在时创建 `{ providers: {} }`, 允许从零建配置 */
  createInitialDoc: () => void;

  setDefaults: (patch: Partial<SessionDefaults>) => void;
  /** 用 doc 里编辑中的 provider 对象测试 (未保存的改动也能测) */
  probe: (pid: string) => Promise<ProbeResult>;
  undoLast: () => void;
  dismissUndo: () => void;

  /** 值为 null / undefined / 空串时删键 */
  setProviderField: (pid: string, key: string, value: unknown) => void;
  addProvider: (pid: string, init: JsonObject) => boolean;
  renameProvider: (oldId: string, newId: string) => boolean;
  deleteProvider: (pid: string) => void;
  duplicateProvider: (pid: string) => string | null;
  /** 长尾字段文本提交; 返回错误文案 (null = 已写入), 空文本表示删除该键 */
  setProviderJson: (pid: string, key: string, text: string) => string | null;

  /** 批量追加模型 (拉取对话框 / 新增输入框); 与现有 id 重复的跳过, 选中第一个新模型 */
  addModels: (pid: string, items: JsonObject[]) => void;
  deleteModel: (pid: string, mid: string) => void;
  /** 按下标删除 models[] 项: 非对象项没有 id, 只能按位置清除 */
  deleteModelAt: (pid: string, index: number) => void;
  renameModel: (pid: string, oldId: string, newId: string) => boolean;
  duplicateModel: (pid: string, mid: string) => string | null;
  /** 复制到其他供应商: 目标里已有同名模型就原位覆盖, 否则追加 */
  copyModelTo: (pid: string, mid: string, targets: string[]) => void;
  /** 值为 null / undefined / 空串时删键 */
  setModelField: (pid: string, mid: string, key: string, value: unknown) => void;
  /** 正整数字段 (contextWindow / maxTokens): null 删键; 非法值 (NaN / 非正) 忽略 */
  setModelNumber: (pid: string, mid: string, key: string, n: number | null) => void;
  /**
   * cost 子字段按「文本提交」写入 (失焦才落盘)。
   * 四个主键任一位被填过 → 缺失键自动补 0, 保证保存产物四键齐全 (pi 启动校验要求);
   * 清空一格 = 该键置 0; tiers 等未知键原样保留。非法数值不落盘, 返回 false 供面板提示。
   */
  setModelCostText: (pid: string, mid: string, key: string, text: string) => boolean;
  /**
   * thinkingLevelMap 的单档写入: level = pi 思考档位键 (off…max)。
   * value undefined → 删除该档 (省略 = 用默认映射); null → 该档显式不支持;
   * 字符串 → 发给 provider 的映射值。删空后整个 map 键删除。
   */
  setModelLevelEntry: (pid: string, mid: string, level: string, value: string | null | undefined) => void;
  /** compat 开关 (模型级): true/false 写入 compat, undefined 删除该键 (跟随 pi 自动探测) */
  setModelCompatFlag: (pid: string, mid: string, key: string, value: boolean | undefined) => void;
  /** JSON 模式整体替换模型对象; 返回错误文案 (null = 已写入) */
  setModelObject: (pid: string, mid: string, next: unknown) => string | null;
  /**
   * 保存前收尾: cost 若存在但缺四主键 → 缺失补 0 (不碰 tiers / 未知键)。
   * 返回新 doc; 无修改时返回原对象。
   */
  normalizeCostForSave: (doc: JsonObject) => JsonObject;
}

export const useModelsConfigStore = create<ModelsConfigStore>((set, get) => {
  // 所有编辑动作的统一入口: 不可变更新 + 重算 dirty + 清掉上一次的保存反馈。
  // 反馈必须在编辑时清, 否则用户看到「已保存」横幅还在, 却已经在改下一版了。
  // dirty 按内容比对而非「改过就置真」: 撤销删除、改回原值后未保存计数要能回落。
  const mutate = (fn: (doc: JsonObject) => JsonObject, extra: Partial<ModelsConfigStore> = {}) => {
    const doc = get().doc;
    if (!doc) return;
    const next = fn(doc);
    set({ doc: next, dirty: JSON.stringify(next) !== baseJson, saveError: null, notice: null, ...extra });
  };

  // 删除前存整份快照 (doc 是结构共享的不可变树, 存引用即可, 不必深拷贝)
  const snapshotForUndo = (label: string): UndoEntry => {
    const s = get();
    return {
      label,
      seq: ++undoSeq,
      doc: s.doc ?? {},
      defaults: s.defaults,
      selectedProvider: s.selectedProvider,
      selectedModelId: s.selectedModelId,
    };
  };

  // 文本 → JSON 值。空文本 = 未设置 (删键); 非法 JSON 返回错误文案交给面板标红。
  const commitJson = (text: string, apply: (value: unknown) => void): string | null => {
    const trimmed = text.trim();
    if (!trimmed) {
      apply(null);
      return null;
    }
    try {
      apply(JSON.parse(trimmed));
      return null;
    } catch (e) {
      return `JSON 解析失败: ${String(e)}`;
    }
  };

  const defaultsDirty = () => {
    const { defaults, defaultsBase } = get();
    return !!defaults && !!defaultsBase && !sameDefaults(defaults, defaultsBase);
  };

  return {
    doc: null,
    docBase: null,
    path: "",
    exists: false,
    mtimeMs: 0,
    parseError: null,
    dirty: false,
    defaults: null,
    defaultsBase: null,
    settingsPath: "",
    settingsParseError: null,
    selectedProvider: null,
    selectedModelId: null,
    saveError: null,
    notice: null,
    loading: false,
    saving: false,
    loaded: false,
    probes: {},
    undo: null,

    load: async (opts) => {
      // 切走 tab 再切回是最高频的路径, 而 SettingsWindow 用条件渲染 (切走即卸载) ——
      // 无保护的自动重载会让用户改了十几个字段后一切就没了, 且没有任何提示。
      // 显式「重新加载」走 force, 面板已做过二次确认。
      if (!opts?.force && get().loaded && (get().dirty || defaultsDirty())) return;
      set({ loading: true, saveError: null });
      const [modelsRes, settingsRes] = await Promise.allSettled([
        invoke<ModelsConfigSnapshot>("read_models_config"),
        invoke<SettingsDefaultsSnapshot>("read_session_defaults"),
      ]);
      if (modelsRes.status === "rejected") {
        set({ loading: false, saveError: String(modelsRes.reason) });
        return;
      }
      const snap = modelsRes.value;
      // settings.json 读不到不拖累 models.json 的编辑: 默认条单独进只读态
      const settings =
        settingsRes.status === "fulfilled"
          ? {
              defaults: settingsRes.value.defaults,
              defaultsBase: settingsRes.value.defaults,
              settingsPath: settingsRes.value.path,
              settingsParseError: settingsRes.value.parse_error,
            }
          : {
              defaults: null,
              defaultsBase: null,
              settingsPath: "",
              settingsParseError: `读取 settings.json 失败: ${String(settingsRes.reason)}`,
            };
      // 重新加载后仍存在的选中项保留, 不在了才回落到第一个
      const prev = get();
      const pids = providerIds(snap.raw);
      const pid = prev.selectedProvider && pids.includes(prev.selectedProvider) ? prev.selectedProvider : pids[0] ?? null;
      const mid =
        pid === prev.selectedProvider && modelOf(snap.raw, pid, prev.selectedModelId)
          ? prev.selectedModelId
          : firstModelId(snap.raw, pid);
      baseJson = JSON.stringify(snap.raw);
      set({
        doc: snap.raw,
        docBase: snap.raw,
        path: snap.path,
        exists: snap.exists,
        mtimeMs: snap.mtime_ms,
        parseError: snap.parse_error,
        dirty: false,
        ...settings,
        selectedProvider: pid,
        selectedModelId: mid,
        undo: null,
        loading: false,
        loaded: true,
        notice: null,
      });
    },

    // 显式重新加载 = 用户已确认放弃本地改动
    reload: async () => {
      await get().load({ force: true });
    },

    save: async () => {
      const { doc: rawDoc, mtimeMs, parseError, saving, dirty, defaults, defaultsBase } = get();
      if (saving) return;
      const wantModels = dirty && !!rawDoc;
      const wantDefaults = defaultsDirty();
      if (!wantModels && !wantDefaults) return;
      if (wantModels && parseError) {
        set({ saveError: "models.json 无法解析, 已禁用保存。请在外部修复 JSON 后重新加载。" });
        return;
      }
      set({ saving: true, saveError: null, notice: null });
      const done: string[] = [];
      const failed: string[] = [];
      let backup: string | null = null;

      // 两个文件独立成败: 一个失败不回滚另一个 (已落盘的就是用户要的), 失败那份的改动留在面板里
      if (wantModels && rawDoc) {
        // 保存前收尾: 任何存在但缺主键的 cost 补 0 —— GUI 绝不存出会让 pi 起不来的残缺 cost。
        // 补全版同时写盘与回写 store, 避免「盘上已补全、界面还显残缺」
        const doc = get().normalizeCostForSave(rawDoc);
        try {
          const res = await invoke<WriteResult>("write_models_config", {
            content: doc,
            expectedMtimeMs: mtimeMs,
          });
          baseJson = JSON.stringify(doc);
          // 保存期间用户若又改了 (保存按钮已禁用, 但 JSON 草稿失焦仍可能写入), 保留新改动
          const latest = get().doc;
          const keep = latest !== rawDoc ? latest : doc;
          set({
            doc: keep,
            docBase: doc,
            mtimeMs: res.mtime_ms,
            dirty: JSON.stringify(keep) !== baseJson,
            exists: true,
          });
          backup = res.backup_path;
          done.push("models.json");
        } catch (e) {
          failed.push(`models.json 保存失败: ${String(e)}`);
        }
      }
      if (wantDefaults && defaults && defaultsBase) {
        try {
          const res = await invoke<SessionDefaults>("write_session_defaults", {
            expected: defaultsBase,
            next: defaults,
          });
          const latest = get().defaults;
          set({ defaults: sameDefaults(latest, defaults) ? res : latest, defaultsBase: res });
          done.push("settings.json");
        } catch (e) {
          failed.push(`settings.json 保存失败: ${String(e)}`);
        }
      }

      if (done.length) {
        // 预热槽已持有旧配置的 pi 进程, 不丢弃的话下一个新建会话会沿用旧配置。
        // 失败只影响「何时生效」, 配置本身已落盘, 因此不计入保存成功判定。
        try {
          await invoke("discard_warm_runtime");
        } catch {
          /* 无预热槽或命令不可用时静默降级 */
        }
      }
      set({
        saving: false,
        // 保存后撤销失去意义: 快照里是保存前的文档, 撤回去等于制造一次反向改动
        undo: done.length ? null : get().undo,
        saveError: failed.length
          ? (done.length ? `${done.join("、")} 已保存; ` : "") + failed.join("; ")
          : null,
        notice: failed.length
          ? null
          : "已保存。新会话立即生效, 运行中的会话重启后生效。" + (backup ? ` 原文件已备份至 ${backup}` : ""),
      });
    },

    dismissNotice: () => set({ notice: null }),
    notify: (text) => set({ notice: text }),

    resetTransient: () => set({ probes: {}, undo: null }),

    selectProvider: (pid) => {
      if (pid === get().selectedProvider || !canLeave()) return;
      set({ selectedProvider: pid, selectedModelId: firstModelId(get().doc, pid) });
    },
    selectModel: (mid) => {
      if (mid === get().selectedModelId || !canLeave()) return;
      set({ selectedModelId: mid });
    },

    // 新建的空文档本身就是一份未保存的改动: 置 loaded 让它免于被切 tab 触发的自动重载冲掉
    createInitialDoc: () => {
      const doc = { providers: {} };
      set({
        doc,
        dirty: JSON.stringify(doc) !== baseJson,
        loaded: true,
        parseError: null,
        selectedProvider: null,
        selectedModelId: null,
        saveError: null,
        notice: null,
      });
    },

    setDefaults: (patch) => {
      const { defaults, settingsParseError } = get();
      if (!defaults || settingsParseError) return;
      set({ defaults: { ...defaults, ...patch }, saveError: null, notice: null });
    },

    probe: async (pid) => {
      const provider = providerOf(get().doc, pid);
      const base = typeof provider.baseUrl === "string" ? provider.baseUrl.trim().replace(/\/+$/, "") : "";
      // 占位对象的引用就是本次请求的令牌: 迟到结果发现槽位已被新请求 / 改名 / 删除替换就丢弃
      const token: ProbeState = { status: "running", url: `${base}/models` };
      set({ probes: { ...get().probes, [pid]: token } });
      let result: ProbeResult;
      try {
        result = await invoke<ProbeResult>("probe_provider_models", { provider });
      } catch (e) {
        result = {
          ok: false,
          url: token.url,
          status: null,
          elapsed_ms: 0,
          models: [],
          error_kind: "internal",
          message: String(e),
        };
      }
      if (get().probes[pid] === token) {
        set({ probes: { ...get().probes, [pid]: { status: "done", result } } });
      }
      return result;
    },

    undoLast: () => {
      const u = get().undo;
      if (!u) return;
      set({
        doc: u.doc,
        dirty: JSON.stringify(u.doc) !== baseJson,
        defaults: u.defaults,
        selectedProvider: u.selectedProvider,
        selectedModelId: u.selectedModelId,
        undo: null,
        saveError: null,
        notice: null,
      });
    },
    dismissUndo: () => set({ undo: null }),

    setProviderField: (pid, key, value) =>
      mutate((doc) => withProvider(doc, pid, (p) => putKey(p, key, value))),

    addProvider: (pid, init) => {
      const clean = pid.trim();
      if (!clean || clean in providersOf(get().doc) || !canLeave()) return false;
      mutate((doc) => ({ ...doc, providers: { ...providersOf(doc), [clean]: init } }), {
        selectedProvider: clean,
        selectedModelId: null,
      });
      return true;
    },

    // 重命名必须重建 providers 的键序: 直接 [newId]: 值 + delete 旧键会把该 provider
    // 挪到末尾, 用户看着列表顺序乱跳。命中新会话默认时默认值同步改名 (同一次改动)
    renameProvider: (oldId, newId) => {
      const clean = newId.trim();
      const providers = providersOf(get().doc);
      if (!clean || !(oldId in providers) || clean in providers) return false;
      const { defaults, probes, selectedProvider } = get();
      // 已完成的测试结果跟着改名; 进行中的丢弃 (迟到结果按旧 id 回写会错位)
      const nextProbes = { ...probes };
      const probe = nextProbes[oldId];
      delete nextProbes[oldId];
      if (probe?.status === "done") nextProbes[clean] = probe;
      mutate(
        (doc) => ({
          ...doc,
          providers: Object.fromEntries(
            Object.entries(providersOf(doc)).map(([k, v]) => (k === oldId ? [clean, v] : [k, v])),
          ),
        }),
        {
          probes: nextProbes,
          defaults: defaults && defaults.provider === oldId ? { ...defaults, provider: clean } : defaults,
          selectedProvider: selectedProvider === oldId ? clean : selectedProvider,
        },
      );
      return true;
    },

    deleteProvider: (pid) => {
      const ids = providerIds(get().doc);
      const i = ids.indexOf(pid);
      if (i < 0) return;
      const undo = snapshotForUndo(`已删除供应商 ${pid}`);
      const rest = ids.filter((x) => x !== pid);
      const probes = { ...get().probes };
      delete probes[pid];
      const wasSelected = get().selectedProvider === pid;
      // 选中项落到原位置的相邻供应商, 列表不跳回顶部
      const nextPid = wasSelected ? rest[Math.min(i, rest.length - 1)] ?? null : get().selectedProvider;
      mutate(
        (doc) => {
          const next = { ...providersOf(doc) };
          delete next[pid];
          return { ...doc, providers: next };
        },
        { undo, probes },
      );
      if (wasSelected) set({ selectedProvider: nextPid, selectedModelId: firstModelId(get().doc, nextPid) });
    },

    duplicateProvider: (pid) => {
      const providers = providersOf(get().doc);
      if (!(pid in providers) || !canLeave()) return null;
      const id = uniqueId(`${pid}-copy`, (c) => c in providers);
      mutate((doc) => ({ ...doc, providers: insertAfter(providersOf(doc), pid, id, structuredClone(providersOf(doc)[pid])) }));
      set({ selectedProvider: id, selectedModelId: firstModelId(get().doc, id) });
      return id;
    },

    setProviderJson: (pid, key, text) =>
      commitJson(text, (value) =>
        mutate((doc) => withProvider(doc, pid, (p) => putKey(p, key, value))),
      ),

    addModels: (pid, items) => {
      const taken = new Set(modelsOf(get().doc, pid).map((m) => m.id));
      const fresh = items.filter((m) => typeof m.id === "string" && m.id && !taken.has(m.id));
      if (!fresh.length) return;
      mutate((doc) => withProvider(doc, pid, (p) => ({ ...p, models: [...rawModelsOf(doc, pid), ...fresh] })), {
        selectedModelId: fresh[0].id as string,
      });
    },

    deleteModel: (pid, mid) => {
      const models = modelsOf(get().doc, pid);
      const i = models.findIndex((m) => m.id === mid);
      if (i < 0) return;
      const undo = snapshotForUndo(`已删除 ${mid}`);
      const rest = models.filter((m) => m.id !== mid);
      const wasSelected = get().selectedModelId === mid;
      const neighbor = rest[Math.min(i, rest.length - 1)]?.id;
      mutate(
        (doc) =>
          withProvider(doc, pid, (p) => ({
            ...p,
            // 只摘掉 id 命中的对象项; 非对象项不是这条模型, 删模型不该连带抹掉它们
            models: rawModelsOf(doc, pid).filter((m) => !(isObj(m) && m.id === mid)),
          })),
        {
          undo,
          selectedModelId: wasSelected ? (typeof neighbor === "string" ? neighbor : null) : get().selectedModelId,
        },
      );
    },

    deleteModelAt: (pid, index) => {
      const raw = rawModelsOf(get().doc, pid);
      if (index < 0 || index >= raw.length) return;
      const undo = snapshotForUndo("已删除非法项");
      mutate(
        (doc) => withProvider(doc, pid, (p) => ({ ...p, models: rawModelsOf(doc, pid).filter((_, i) => i !== index) })),
        { undo },
      );
    },

    renameModel: (pid, oldId, newId) => {
      const clean = newId.trim();
      const models = modelsOf(get().doc, pid);
      if (!clean || !models.some((m) => m.id === oldId) || models.some((m) => m.id === clean)) return false;
      const { defaults, selectedModelId } = get();
      mutate((doc) => withModel(doc, pid, oldId, (m) => ({ ...m, id: clean })), {
        defaults:
          defaults && defaults.provider === pid && defaults.model === oldId ? { ...defaults, model: clean } : defaults,
        selectedModelId: selectedModelId === oldId ? clean : selectedModelId,
      });
      return true;
    },

    duplicateModel: (pid, mid) => {
      const src = modelOf(get().doc, pid, mid);
      if (!src || !canLeave()) return null;
      const id = uniqueId(`${mid}-copy`, (c) => modelsOf(get().doc, pid).some((m) => m.id === c));
      mutate(
        (doc) =>
          withProvider(doc, pid, (p) => {
            const raw = rawModelsOf(doc, pid);
            const at = raw.findIndex((m) => isObj(m) && m.id === mid);
            const copy = { ...structuredClone(src), id };
            return { ...p, models: [...raw.slice(0, at + 1), copy, ...raw.slice(at + 1)] };
          }),
        { selectedModelId: id },
      );
      return id;
    },

    copyModelTo: (pid, mid, targets) => {
      const src = modelOf(get().doc, pid, mid);
      if (!src) return;
      mutate((doc) => {
        let next = doc;
        for (const t of targets) {
          if (t === pid) continue;
          next = withProvider(next, t, (p) => {
            const raw = rawModelsOf(next, t);
            const at = raw.findIndex((m) => isObj(m) && m.id === mid);
            const copy = structuredClone(src);
            return { ...p, models: at >= 0 ? raw.map((m, i) => (i === at ? copy : m)) : [...raw, copy] };
          });
        }
        return next;
      });
    },

    setModelField: (pid, mid, key, value) =>
      mutate((doc) => withModel(doc, pid, mid, (m) => putKey(m, key, value))),

    setModelNumber: (pid, mid, key, n) => {
      // pi 侧要求正整数 (后端同规则), 非法值不落盘: 与其存一个让 pi 起不来的值, 不如保持原值
      if (n !== null && (!Number.isInteger(n) || n <= 0)) return;
      mutate((doc) => withModel(doc, pid, mid, (m) => putKey(m, key, n)));
    },

    // 空串 → 把该键置 0 (不是删键): 四键齐全是 pi 启动校验的硬要求。
    // 删除整个 cost 只能由用户显式点「清除价格」(setModelField null)。
    setModelCostText: (pid, mid, key, text) => {
      const t = text.trim();
      if (t) {
        const n = Number(t);
        if (!Number.isFinite(n) || n < 0) return false;
        mutate((doc) =>
          withModel(doc, pid, mid, (m) => {
            const prev = isObj(m.cost) ? m.cost : {};
            // 只补「键不存在」的主键为 0, 已有键 (含非数字怪值) 不动:
            // 用户这次只改这一格, 不该顺带覆盖其它格的既有值
            const next = { ...prev, [key]: n };
            for (const k of COST_MAIN_KEYS) if (!(k in next)) next[k] = 0;
            return { ...m, cost: next };
          }),
        );
        return true;
      }
      // 空串 → 0 (若原本就没有 cost 键则整单保持无 cost, 不为空点一下失焦造出全零 cost)
      mutate((doc) =>
        withModel(doc, pid, mid, (m) => {
          const prev = isObj(m.cost) ? m.cost : {};
          if (Object.keys(prev).length === 0) return m;
          const next = { ...prev, [key]: 0 };
          for (const k of COST_MAIN_KEYS) if (!(k in next)) next[k] = 0;
          return { ...m, cost: next };
        }),
      );
      return true;
    },

    setModelLevelEntry: (pid, mid, level, value) =>
      mutate((doc) =>
        withModel(doc, pid, mid, (m) => {
          const prev = isObj(m.thinkingLevelMap) ? { ...m.thinkingLevelMap } : {};
          if (value === undefined) delete prev[level];
          else prev[level] = value;
          return Object.keys(prev).length ? { ...m, thinkingLevelMap: prev } : putKey(m, "thinkingLevelMap", null);
        }),
      ),

    setModelCompatFlag: (pid, mid, key, value) =>
      mutate((doc) =>
        withModel(doc, pid, mid, (m) => {
          const prev = isObj(m.compat) ? { ...m.compat } : {};
          if (value === undefined) delete prev[key];
          else prev[key] = value;
          return Object.keys(prev).length ? { ...m, compat: prev } : putKey(m, "compat", null);
        }),
      ),

    setModelObject: (pid, mid, next) => {
      if (!isObj(next)) return "需要是一个 JSON 对象";
      const id = typeof next.id === "string" ? next.id.trim() : "";
      if (!id) return "需要有非空的 id";
      if (id !== next.id) return "id 不能带前后空白";
      if (id !== mid && modelsOf(get().doc, pid).some((m) => m.id === id)) {
        return `id「${id}」在这个供应商里已经存在`;
      }
      const { defaults, selectedModelId } = get();
      mutate((doc) => withModel(doc, pid, mid, () => next), {
        defaults:
          id !== mid && defaults && defaults.provider === pid && defaults.model === mid
            ? { ...defaults, model: id }
            : defaults,
        selectedModelId: selectedModelId === mid ? id : selectedModelId,
      });
      return null;
    },

    // 保存前收尾: 只补缺失的四主键为 0, 绝不碰 tiers / 未知键 / 其余文档。
    // 注意只补「键不存在」的主键 —— 若主键存在但值非数字 (第三方工具写的 stringly-number),
    // 原样保留并交给后端校验如实报错定位, 绝不静默把 "2.5" 覆盖成 0 (丢价格)。
    // 返回新 doc (无改动时原对象)
    normalizeCostForSave: (doc) => {
      let changed = false;
      const providers: JsonObject = {};
      for (const [pid, pv] of Object.entries(providersOf(doc))) {
        const p = isObj(pv) ? pv : {};
        if (!Array.isArray(p.models)) {
          providers[pid] = pv;
          continue;
        }
        providers[pid] = {
          ...p,
          models: p.models.map((m) => {
            if (!isObj(m)) return m;
            const cost = m.cost;
            if (!isObj(cost)) return m;
            const miss = COST_MAIN_KEYS.filter((k) => !(k in cost));
            if (!miss.length) return m;
            changed = true;
            return { ...m, cost: { ...cost, ...Object.fromEntries(miss.map((k) => [k, 0])) } };
          }),
        };
      }
      return changed ? { ...doc, providers } : doc;
    },
  };
});
