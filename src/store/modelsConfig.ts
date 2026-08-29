// models.json 配置面板 store (设置窗「模型与供应商」tab): 整份文档的本地编辑态 + 保存。
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

export const isObj = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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

export function overridesOf(doc: JsonObject | null, pid: string | null): JsonObject {
  const ov = providerOf(doc, pid).modelOverrides;
  return isObj(ov) ? ov : {};
}

// 值为 null / 空字符串 → 删除该键: pi 侧「未设置」就是缺省, 存空串会让 pi 拿到空 baseUrl
function putKey(obj: JsonObject, key: string, value: unknown): JsonObject {
  const next = { ...obj };
  if (value === null || value === "") delete next[key];
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

/** 生成不与现有 id 冲突的新条目 id (new-model / new-model-2 ...) */
function uniqueId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; ; i++) {
    const cand = `${base}-${i}`;
    if (!taken(cand)) return cand;
  }
}

export interface ModelsConfigStore {
  /** 整份文档, 编辑的唯一真相; null = 文件不存在或 JSON 非法 */
  doc: JsonObject | null;
  path: string;
  exists: boolean;
  mtimeMs: number;
  parseError: string | null;
  dirty: boolean;
  selectedProvider: string | null;
  selectedModelId: string | null;
  saveError: string | null;
  /** 保存成功横幅 (design §3.4 的生效时机说明) */
  savedNotice: string | null;
  loading: boolean;
  saving: boolean;
  /** 是否已成功加载过一次; 面板据此区分「首次打开」与「切走 tab 又切回」 */
  loaded: boolean;

  /**
   * 拉取快照。force=false (默认) 时若已加载过且存在未保存改动, 直接返回 —— 面板每次挂载
   * 都会调用它, 而切走 tab 会卸载面板, 无保护的重载等于静默丢弃用户改动。
   */
  load: (opts?: { force?: boolean }) => Promise<void>;
  reload: () => Promise<void>;
  save: () => Promise<void>;
  dismissNotice: () => void;

  selectProvider: (pid: string | null) => void;
  selectModel: (mid: string | null) => void;
  /** 文件不存在时创建 `{ providers: {} }`, 允许从零建配置 */
  createInitialDoc: () => void;

  setProviderField: (pid: string, key: string, value: string | null) => void;
  addProvider: (pid: string) => boolean;
  renameProvider: (oldId: string, newId: string) => boolean;
  deleteProvider: (pid: string) => void;
  /** 长尾字段文本提交; 返回错误文案 (null = 已写入), 空文本表示删除该键 */
  setProviderJson: (pid: string, key: string, text: string) => string | null;

  addModel: (pid: string) => void;
  deleteModel: (pid: string, mid: string) => void;
  /** 按下标删除 models[] 项: 非对象项没有 id, 只能按位置清除 */
  deleteModelAt: (pid: string, index: number) => void;
  renameModel: (pid: string, oldId: string, newId: string) => boolean;
  /**
   * 数组值放宽到 unknown[]: input[] 里可能有本版本不认识的模态取值 (不只是 text / image),
   * 保真要求它们原样写回, 类型上就不能逼它们都是 string。
   */
  setModelField: (pid: string, mid: string, key: string, value: string | boolean | unknown[] | null) => void;
  /** 正整数字段 (contextWindow / maxTokens): 非法输入忽略, 空输入删除键 */
  setModelNumber: (pid: string, mid: string, key: string, text: string) => void;
  /** cost 子字段; cost 空了就删掉整个 cost 键, tiers 等未知键原样保留 */
  setModelCost: (pid: string, mid: string, key: string, text: string) => void;
  setModelJson: (pid: string, mid: string, key: string, text: string) => string | null;

  addModelOverride: (pid: string, mid: string) => boolean;
  deleteModelOverride: (pid: string, mid: string) => void;
  setModelOverrideJson: (pid: string, mid: string, text: string) => string | null;
}

export const useModelsConfigStore = create<ModelsConfigStore>((set, get) => {
  // 所有编辑动作的统一入口: 不可变更新 + 置 dirty + 清掉上一次的保存反馈。
  // 反馈必须在编辑时清, 否则用户看到「已保存」横幅还在, 却已经在改下一版了。
  const mutate = (fn: (doc: JsonObject) => JsonObject) => {
    const doc = get().doc;
    if (!doc) return;
    set({ doc: fn(doc), dirty: true, saveError: null, savedNotice: null });
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

  return {
    doc: null,
    path: "",
    exists: false,
    mtimeMs: 0,
    parseError: null,
    dirty: false,
    selectedProvider: null,
    selectedModelId: null,
    saveError: null,
    savedNotice: null,
    loading: false,
    saving: false,
    loaded: false,

    load: async (opts) => {
      // 切走 tab 再切回是最高频的路径, 而 SettingsWindow 用条件渲染 (切走即卸载) ——
      // 无保护的自动重载会让用户改了十几个字段后一切就没了, 且没有任何提示。
      // 显式「重新加载」按钮走 force, 它自己已经 confirm 过。
      if (!opts?.force && get().loaded && get().dirty) return;
      set({ loading: true, saveError: null });
      try {
        const snap = await invoke<ModelsConfigSnapshot>("read_models_config");
        const ids = providerIds(snap.raw);
        // 每次加载都重置选中项与 dirty: 重新加载的语义就是放弃本地改动
        set({
          doc: snap.raw,
          path: snap.path,
          exists: snap.exists,
          mtimeMs: snap.mtime_ms,
          parseError: snap.parse_error,
          dirty: false,
          selectedProvider: ids[0] ?? null,
          selectedModelId: null,
          loading: false,
          loaded: true,
          savedNotice: null,
        });
      } catch (e) {
        set({ loading: false, saveError: String(e) });
      }
    },

    // 显式重新加载 = 用户已确认放弃本地改动
    reload: async () => {
      await get().load({ force: true });
    },

    save: async () => {
      const { doc, mtimeMs, parseError, saving } = get();
      if (saving) return;
      if (parseError) {
        set({ saveError: "配置文件无法解析, 已禁用保存。请在外部修复 JSON 后重新加载。" });
        return;
      }
      if (!doc) return;
      set({ saving: true, saveError: null, savedNotice: null });
      try {
        const res = await invoke<WriteResult>("write_models_config", {
          content: doc,
          expectedMtimeMs: mtimeMs,
        });
        set({
          mtimeMs: res.mtime_ms,
          dirty: false,
          exists: true,
          saving: false,
          savedNotice:
            "配置已保存。新建会话立即生效; 已运行的会话需重启后生效。" +
            (res.backup_path ? ` 原文件已备份至 ${res.backup_path}` : ""),
        });
        // 预热槽已持有旧配置的 pi 进程, 不丢弃的话下一个新建会话会沿用旧配置。
        // 失败只影响「何时生效」, 配置本身已落盘, 因此不计入保存成功判定。
        try {
          await invoke("discard_warm_runtime");
        } catch {
          /* 无预热槽或命令不可用时静默降级 */
        }
      } catch (e) {
        set({ saving: false, saveError: String(e) });
      }
    },

    dismissNotice: () => set({ savedNotice: null }),

    selectProvider: (pid) => set({ selectedProvider: pid, selectedModelId: null }),
    selectModel: (mid) => set({ selectedModelId: mid }),

    // 新建的空文档本身就是一份未保存的改动: 置 loaded 让它免于被切 tab 触发的自动重载冲掉
    createInitialDoc: () =>
      set({
        doc: { providers: {} },
        dirty: true,
        loaded: true,
        parseError: null,
        selectedProvider: null,
        selectedModelId: null,
        saveError: null,
        savedNotice: null,
      }),

    setProviderField: (pid, key, value) =>
      mutate((doc) => withProvider(doc, pid, (p) => putKey(p, key, value))),

    addProvider: (pid) => {
      const clean = pid.trim();
      if (!clean || clean in providersOf(get().doc)) return false;
      mutate((doc) => ({ ...doc, providers: { ...providersOf(doc), [clean]: {} } }));
      set({ selectedProvider: clean, selectedModelId: null });
      return true;
    },

    // 重命名必须重建 providers 的键序: 直接 [newId]: 值 + delete 旧键会把该 provider
    // 挪到末尾, 用户看着列表顺序乱跳
    renameProvider: (oldId, newId) => {
      const clean = newId.trim();
      const providers = providersOf(get().doc);
      if (!clean || !(oldId in providers) || clean in providers) return false;
      mutate((doc) => ({
        ...doc,
        providers: Object.fromEntries(
          Object.entries(providersOf(doc)).map(([k, v]) => (k === oldId ? [clean, v] : [k, v])),
        ),
      }));
      if (get().selectedProvider === oldId) set({ selectedProvider: clean, selectedModelId: null });
      return true;
    },

    deleteProvider: (pid) => {
      mutate((doc) => {
        const next = { ...providersOf(doc) };
        delete next[pid];
        return { ...doc, providers: next };
      });
      if (get().selectedProvider === pid) {
        set({ selectedProvider: providerIds(get().doc)[0] ?? null, selectedModelId: null });
      }
    },

    setProviderJson: (pid, key, text) =>
      commitJson(text, (value) =>
        mutate((doc) => withProvider(doc, pid, (p) => putKey(p, key, value))),
      ),

    addModel: (pid) => {
      const id = uniqueId("new-model", (cand) => modelsOf(get().doc, pid).some((m) => m.id === cand));
      mutate((doc) =>
        withProvider(doc, pid, (p) => ({ ...p, models: [...rawModelsOf(doc, pid), { id }] })),
      );
      set({ selectedModelId: id });
    },

    deleteModel: (pid, mid) => {
      mutate((doc) =>
        withProvider(doc, pid, (p) => ({
          ...p,
          // 只摘掉 id 命中的对象项; 非对象项不是这条模型, 删模型不该连带抹掉它们
          models: rawModelsOf(doc, pid).filter((m) => !(isObj(m) && m.id === mid)),
        })),
      );
      if (get().selectedModelId === mid) set({ selectedModelId: null });
    },

    deleteModelAt: (pid, index) => {
      mutate((doc) =>
        withProvider(doc, pid, (p) => {
          const raw = rawModelsOf(doc, pid);
          if (index < 0 || index >= raw.length) return p;
          return { ...p, models: raw.filter((_, i) => i !== index) };
        }),
      );
    },

    renameModel: (pid, oldId, newId) => {
      const clean = newId.trim();
      const models = modelsOf(get().doc, pid);
      if (!clean || !models.some((m) => m.id === oldId) || models.some((m) => m.id === clean)) return false;
      mutate((doc) => withModel(doc, pid, oldId, (m) => ({ ...m, id: clean })));
      if (get().selectedModelId === oldId) set({ selectedModelId: clean });
      return true;
    },

    setModelField: (pid, mid, key, value) =>
      mutate((doc) => withModel(doc, pid, mid, (m) => putKey(m, key, value))),

    setModelNumber: (pid, mid, key, text) => {
      const t = text.trim();
      if (!t) {
        mutate((doc) => withModel(doc, pid, mid, (m) => putKey(m, key, null)));
        return;
      }
      const n = Number(t);
      // pi 侧要求正整数 (后端同规则), 非法输入不落盘: 与其存一个让 pi 起不来的值,
      // 不如保持原值不动
      if (!Number.isInteger(n) || n <= 0) return;
      mutate((doc) => withModel(doc, pid, mid, (m) => ({ ...m, [key]: n })));
    },

    setModelCost: (pid, mid, key, text) => {
      const t = text.trim();
      mutate((doc) =>
        withModel(doc, pid, mid, (m) => {
          const cost = isObj(m.cost) ? { ...m.cost } : {};
          if (!t) delete cost[key];
          else {
            const n = Number(t);
            if (!Number.isFinite(n) || n < 0) return m;
            cost[key] = n;
          }
          return Object.keys(cost).length ? { ...m, cost } : putKey(m, "cost", null);
        }),
      );
    },

    setModelJson: (pid, mid, key, text) =>
      commitJson(text, (value) =>
        mutate((doc) => withModel(doc, pid, mid, (m) => putKey(m, key, value))),
      ),

    addModelOverride: (pid, mid) => {
      const clean = mid.trim();
      if (!clean || clean in overridesOf(get().doc, pid)) return false;
      mutate((doc) =>
        withProvider(doc, pid, (p) => ({
          ...p,
          modelOverrides: { ...overridesOf(doc, pid), [clean]: {} },
        })),
      );
      return true;
    },

    deleteModelOverride: (pid, mid) =>
      mutate((doc) => {
        const next = { ...overridesOf(doc, pid) };
        delete next[mid];
        return withProvider(doc, pid, (p) =>
          Object.keys(next).length ? { ...p, modelOverrides: next } : putKey(p, "modelOverrides", null),
        );
      }),

    setModelOverrideJson: (pid, mid, text) =>
      commitJson(text, (value) =>
        mutate((doc) =>
          withProvider(doc, pid, (p) => ({
            ...p,
            modelOverrides: {
              ...overridesOf(doc, pid),
              [mid]: value === null ? {} : value,
            },
          })),
        ),
      ),
  };
});
