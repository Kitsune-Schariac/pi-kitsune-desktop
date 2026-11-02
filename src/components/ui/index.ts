// 内部 UI 原语统一出口: 手搓 token 驱动组件, 不引外部组件库。
// 样式全走 index.css 的日间 / 夜间 token, 间距 4px 整档, 字号 7 档。
// 使用规范: 新 UI 一律从这里取组件, 不再散写样式串, 也不再直接用原生 select / checkbox / range。

export { Button } from "./Button";
export type { ButtonVariant, ButtonSize } from "./Button";
export { Input, Textarea, DateInput, FieldLabel, FIELD_BASE } from "./Input";
export type { FieldSurface, FieldSize } from "./Input";
export { Select } from "./Select";
export type { SelectDensity, SelectOption } from "./Select";
export { Segmented } from "./Segmented";
export type { SegmentedSize, SegmentedOption } from "./Segmented";
export { Switch, Checkbox, Slider } from "./Controls";
export { Card, Section, SettingRow, Badge, EmptyHint } from "./Card";
export { CopyButton } from "./CopyButton";
