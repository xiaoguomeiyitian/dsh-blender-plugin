#!/bin/bash
# scripts/build-local.sh —— **轻量本地构建**：只做 src/ → lib/ 的编译，不动依赖
#
# 为什么需要它（2026-10-29 实测踩坑）：
#   scripts/build.sh 是**完整构建**，它会 (a) 需要 dsh checkout 的 node_modules、
#   (b) 用 link_pkg 把 node_modules/@deepseek-ai/* 换成指向 checkout 的 symlink。
#   本机没有可用的 checkout 依赖（/root/dsh/deepseek-harness 没装 node_modules），
#   所以 build.sh 跑不起来 ⇒ 改 src/*.ts 之后**没法重新生成 lib/** ⇒
#   只能手工同步 lib/index.js ⇒ **忘了同步 = 修复不生效**，
#   而且现场极具迷惑性（源码明明改对了，工具还是旧行为）。
#   实测：blender_rt_txn 的错误信息修复（errText）提交了、src 也改了，
#        但 lib/ 里没有 ⇒ 重启后仍显示 "TXN revert 失败 · unknown"。
#
# 本脚本只做**编译**（tsc → lib/），不碰 node_modules、不需要 dsh checkout。
# 类型检查不严格（--noEmitOnError false：即使有类型错误也照样 emit），
# 真正的类型检查请用 `npm run typecheck`（需要完整依赖）。
#
# 用法：
#   bash scripts/build-local.sh              # 编译 src/ → lib/
#   DSH_TSC=/path/to/tsc bash scripts/build-local.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 找 tsc：DSH_TSC → 本包 node_modules → PATH → 机器上常见的几处
TSC="${DSH_TSC:-}"
if [ -z "$TSC" ]; then
  for c in \
    "$ROOT/node_modules/typescript/bin/tsc" \
    /root/core_ts/node_modules/typescript/bin/tsc \
    /root/ai-proxy/node_modules/typescript/bin/tsc \
    /root/cig-mcp/node_modules/typescript/bin/tsc \
    /root/dsh/deepseek-harness/node_modules/typescript/bin/tsc
  do
    if [ -f "$c" ]; then TSC="$c"; break; fi
  done
fi
if [ -z "$TSC" ]; then
  echo "build-local: 找不到 tsc —— 设 DSH_TSC=<绝对路径> 指向一个 typescript 包的 bin/tsc" >&2
  exit 1
fi
echo "build-local: tsc = $TSC"

# --ignoreConfig：命令行给了文件时不再读 tsconfig.json（TS 5.x 会因两者并存报 TS5112）
# 其余选项与仓库 tsconfig.json 对齐（target/module/moduleResolution/skipLibCheck/esModuleInterop）
node "$TSC" --ignoreConfig \
  --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --skipLibCheck --esModuleInterop \
  --outDir lib --rootDir src \
  --noEmitOnError false --declaration false --sourceMap true \
  src/index.ts

echo "build-local: 完成 ⇒ lib/index.js（$(wc -l < lib/index.js) 行）+ lib/tui-host.js"
echo "build-local: 提醒：插件代码要生效**必须重启 DSH**（插件是 DSH 启动时加载的模块）"
