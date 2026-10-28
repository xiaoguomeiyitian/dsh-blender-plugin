#!/usr/bin/env node
/**
 * S4 · 计数同步器：**catalog 是唯一真源**，本脚本把数字刷进各处展示文案。
 *
 * 用法：node scripts/sync_counts.mjs          # 写入（把过时数字刷新）
 *       node scripts/sync_counts.mjs --dry    # 只报告差异，不写
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const cat = (await import(pathToFileURL(path.join(ROOT, "runtime", "engine.mjs")).href)).catalogPayload({});
const fams = cat.families.length;
const ops = cat.ops_count;
const dry = process.argv.includes("--dry");

// 文档里数字的写法实测有这些变体，全部要覆盖：
//   「33 family / 217 op」「33 个 family / 217 个 op」「33 family 217 op」
//   「catalog（33/217）」「catalog 不是 33-217」「catalog 不是 33/217」
//   「catalog 的 33/217」「catalog 仍是 33/217」「复核 33/217」
// 一律锚在 family / op / catalog 字样上 ⇒ 端口(9876/9877)、尺寸(3/58 m) 不会被误伤。
const countPairs = [
  [/(\d+) family \/ (\d+) op/g, fams + " family / " + ops + " op"],
  [/(\d+) 个 family \/ (\d+) 个 op/g, fams + " 个 family / " + ops + " 个 op"],
  [/(\d+) family (\d+) op/g, fams + " family " + ops + " op"],
  [/(\d{3}) 个 op/g, ops + " 个 op"],
  [/catalog（(\d+)\/(\d+)）/g, "catalog（" + fams + "/" + ops + "）"],
  [/catalog 不是 (\d+)-(\d+)/g, "catalog 不是 " + fams + "-" + ops],
  [/catalog 不是 (\d+)\/(\d+)/g, "catalog 不是 " + fams + "/" + ops],
  [/catalog 的 (\d+)\/(\d+)/g, "catalog 的 " + fams + "/" + ops],
  [/catalog 仍是 (\d+)\/(\d+)/g, "catalog 仍是 " + fams + "/" + ops],
  [/复核 (\d+)\/(\d+)/g, "复核 " + fams + "/" + ops],
];

const targets = [
  { file: path.join(ROOT, "src", "index.ts"),
    pairs: [[/(【判定 \/ 验收 \/ 导出 \/ 造型】)\d+ 个 family · \d+ 个 op/,
             "$1" + fams + " 个 family · " + ops + " 个 op"]] },
  // AGENTS.md 两份都要刷：工作区那份（single_source_selftest 校验）和**仓内那份**
  // （随插件发布、被助手自动加载的项目说明）。
  // 三种写法都出现过：2.6.0「33 个 family / 217 个 op」、2.6.1「33 family / 217 op」、
  // 还有速查里的「catalog（33/217）」与故障表的「catalog 不是 33-217」。
  // 同一句在一份文件里出现多次，必须 /g，否则只刷第一处（实测就漏过）。
  ...[path.join(ROOT, "..", "AGENTS.md"), path.join(ROOT, "AGENTS.md")].map((file) => ({
    file,
    pairs: countPairs,
  })),
  // 「当前状态」类文档：这些文件描述的是**当下**该是什么样，数字必须跟着 catalog 走。
  // 历史件（发版说明 / 归档验收报告）**不在此列** —— 里面的数字是那时的历史事实，改了就失真。
  ...[
    "docs/给第三方的安装清单.md",
    "docs/操作教程.md",
    "docs/宿主集成-接口契约-v2.3增补.md",
    "docs/配置参考.md",
    "docs/DSH-更新适配.md",
    "docs/部署SOP.md",
    "docs/AI-安装提示词.md",
  ].map((rel) => ({ file: path.join(ROOT, rel), pairs: countPairs })),
];

// 文档也要刷：操作教程与随包 skill（两者都会被用户/AI 当事实源读）。
for (const rel of ["docs/操作教程.md", "skills/blender-modeling/SKILL.md"]) {
  targets.push({
    file: path.join(ROOT, rel),
    pairs: [[/\d+ (?:个 )?family \/ \d+ (?:个 )?op/g, fams + " 个 family / " + ops + " 个 op"]],
  });
}

let changed = 0;
for (const t of targets) {
  if (!fs.existsSync(t.file)) { console.log("跳过（不存在）: " + t.file); continue; }
  const s = fs.readFileSync(t.file, "utf8");
  let s2 = s;
  for (const [re, rep] of t.pairs) s2 = s2.replace(re, rep);
  if (s2 === s) { console.log("已一致: " + path.basename(t.file)); continue; }
  if (dry) { console.log("需更新(dry): " + t.file); }
  else { fs.writeFileSync(t.file, s2, "utf8"); console.log("已更新: " + t.file); }
  changed++;
}
console.log("catalog 现算：" + fams + " family / " + ops + " op；" + (dry ? "需改 " : "已改 ") + changed + " 个文件");