# plugin-fork-deltas — 部署副本对上游仓的补丁

部署用的插件副本 `/root/dsh/dsh-blender-plugin-review`（profile 软链指向它）相对上游
`sixtysevenlf/dsh-blender-plugin` 有**三处 fork delta**，均为本部署形态所必需：

| # | 改动 | 为什么 | 记录 |
|---|---|---|---|
| ① | `runtime/server.mjs`：`const HOST = process.env.DSH_BLENDER_HTTP_HOST \|\| '127.0.0.1';` | 原写死 127.0.0.1；blender 容器里的 addon 要经 `DSH_BLENDER_BACKEND_URL` 回访（选中/集合下发），后端必须对 mynet 可见。实例模式下由管理器逐实例 env 注入（`0.0.0.0`） | 本文件下方 patch ① |
| ② | `runtime/engine.mjs`：新增 `readAddonFile()`；`frame()/frameArea()/view()` 的落盘读回改为「本地读到就用；ENOENT 时 execute_code 让 addon 把同一文件 base64 经 socket 回传」 | 上游 workDir 模型是同机共享（WSL/Windows）；跨容器两侧文件系统不同，本地读必然 ENOENT → /frame.png 502。同机拓扑行为不变 | 本文件下方 patch ② |
| ③ | `src/index.ts` + `lib/`：**会话级一次性实例路由**（按 `exec.agent.id` 分配实例、holder 变 `inst-<id>`、出口即路由、`blender_viewport(op="instance")` 运维面、15 个工具加可选 `instance` 参数） | 解决租约进程级失效 / 场景全局共享 / 主线程单点 / 容器常驻四个真问题 | [插件仓 session-routing.md](../../dsh-blender-plugin-review/plugin-fork-deltas/session-routing.md) |

**工具数仍是 15**（③ 没有新增模型工具）；plan catalog 的计数随上游走 —— 2026-10-26 上游新增 `surface` 家族后为 **34 family / 228 op**。

## 本机落地形态：三处都是**本地提交**，不是待应用的 patch

```
git -C /root/dsh/dsh-blender-plugin-review log --oneline origin/main..HEAD
  0d760e8 实例模式加固：出口一律 ensure + 工具超时放宽
  e965666 fork delta ③：会话级一次性实例路由
  df46e2a Merge remote-tracking branch 'origin/main'
  9246be3 fork delta: 跨容器适配（① HOST env + ② PNG base64 回传）
```

## 升级时怎么重放

```bash
git -C /root/dsh/dsh-blender-plugin-review fetch --all
git -C /root/dsh/dsh-blender-plugin-review rebase origin/main
```

- **不要 `git apply cross-container.patch`** —— ①②早已在提交历史里，apply 会报
  `patch does not apply`（实测）。该 patch 文件只作**对照/手工恢复**用。
- rebase 冲突时，按上表手工等效修改；③ 的冲突面最小（只改 4 个出口函数）。
- 改完必须：**重建 `lib/`**（若动过 `src/`）→ **重启 DSH**（插件是启动时加载的模块）。
  重建与回归清单见 [REDEPLOY.md 场景 F](../../blender/REDEPLOY.md#场景-f插件升级上游新版)。

## patch 文件（对照用）

```bash
# ① ② 的快照（生成于 ①②合入之前，现已不能再直接 apply）
git -C /root/dsh/dsh-blender-plugin-review diff > plugin-fork-deltas/cross-container.patch
```

## 加载边界（改哪儿要重启什么）

| 改的东西 | 要做什么 |
|---|---|
| `runtime/*.mjs`（后端侧） | 只影响**后端进程**。单例形态：`blender_viewport(op="restart")`；**实例形态：每个实例是独立后端进程 ⇒ release 旧实例让下次调用重建** |
| `lib/`（DSH 侧工具面） | 必须**重启 DSH** |
| `src/index.ts` | 先重建 `lib/`，再重启 DSH |
| `addon/dsh_blender_bridge.py` | 重建镜像 `blender-dsh-bridge:1.10` + 重建实例（addon 在镜像内） |
