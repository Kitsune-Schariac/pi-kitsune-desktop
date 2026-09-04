#!/usr/bin/env node
// 版本号同步工具: 一次把三处版本号改成同一值
//   node bump-version.mjs 0.2.0
// 三处:
//   - package.json          (前端 npm 版本)
//   - src-tauri/tauri.conf.json  (打包产物版本, Tauri 实际读这里)
//   - src-tauri/Cargo.toml  ([package] 段 version, 只改包版本不碰依赖版本)
// 实现用行级文本替换 (不 JSON.parse/stringify 重写), 保留各文件原有手写格式。
// 用法: 发布前先 bump, 再 `npm run tauri build`; 发布后打 git tag v<版本>

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const next = process.argv[2];

if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error("用法: node bump-version.mjs <x.y.z>  例如 node bump-version.mjs 0.2.0");
  process.exit(1);
}

/** JSON 文件: 行级替换指定 key 的 version 值 (保留原格式), 返回旧值 */
function bumpJsonLine(filePath, key) {
  const text = readFileSync(filePath, "utf-8");
  const oldVal = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`))?.[1];
  if (!oldVal) throw new Error(`${filePath} 找不到 ${key} 字段`);
  const updated = text.replace(new RegExp(`("${key}"\\s*:\\s*")[^"]+(")`), `$1${next}$2`);
  writeFileSync(filePath, updated);
  return oldVal;
}

const oldPkg = bumpJsonLine(join(root, "package.json"), "version");
const oldConf = bumpJsonLine(join(root, "src-tauri/tauri.conf.json"), "version");

// Cargo.toml: 只改 [package] 段第一个 "version = " (依赖版本行不动)
const cargoPath = join(root, "src-tauri/Cargo.toml");
const cargo = readFileSync(cargoPath, "utf-8");
const oldCargo = cargo.match(/^version = "([^"]+)"/m)?.[1];
if (!oldCargo) throw new Error("Cargo.toml 找不到 [package] version");
writeFileSync(cargoPath, cargo.replace(/^version = "[^"]+"/m, `version = "${next}"`));

console.log(`版本 ${oldPkg} → ${next} (三处同步)`);
console.log(`  package.json      ${oldPkg} → ${next}`);
console.log(`  tauri.conf.json   ${oldConf} → ${next}`);
console.log(`  Cargo.toml        ${oldCargo} → ${next}`);
console.log(`\n下一步: npm run tauri build 打包; 发布后: git tag v${next} && git push origin v${next}`);
