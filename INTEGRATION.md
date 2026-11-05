# 集成 playbook：把 `port/v3.0.5-delta` 接回现役插件仓

> 生成于 v3.0.5 移植完成后（存档态）。现役生产仍跑 v2.6.2 基底（`15e413f`，
> 备份分支 `backup/pre-v3-port-2026-11-04` 已推 fork 远端）。
> 本分支只做了 unit/python/lint/typecheck 级验证，**未经真机（GUI / 容器）验证**，
> 因此集成必须在维护窗口做，且带着回滚预案。

## 0. 三个前置决策（集成前先拍板）

| 决策 | 建议 | 理由 |
|---|---|---|
| 包名 | **保留上游新名 `dsh-blender-plugin`**，部署标识外移到 git tag/目录 | 上游 v3.0.0 刻意改名（`MIGRATIONS.md:54`，scoped 名从未发布过 npm）；profile 的 `id: dsh-blender-plugin` 恰好等于新名，改回 scoped 名反而会撞 v3 的四处契约断言 |
| 版本号 | tag 承担部署标识（如 `v3.0.5-deploy.1`），不改 package.json 的 name | 同上 |
| addon | **继续用旧单文件 addon 起步**（两边 protocol 都是 11，宿主侧不依赖 v1.11 新命令），或择期整包切 v3 addon | v3 的 addon 是 **v1.11 / protocol 11**，发布形态为 `addon/dsh_blender_bridge/` 包 + 提交的 zip；现役部署副本是旧单文件 `dsh_blender_bridge.py`（v1.10 时代，protocol 11）。切包须整包替换 `dsh-deploy/container-bridge/addon/` 副本 + 重建 `blender-dsh-bridge:1.10` 镜像，属独立变更，别和集成混做 |

## 1. 集成步骤（主仓 /root/dsh/dsh-blender-plugin-review）

```bash
cd /root/dsh/dsh-blender-plugin-review
git status                       # 必须干净；不干净先处理
git checkout local/dsh-deploy-delta
git merge port/v3.0.5-delta      # 预期：package.json name/version 一行冲突，按 §0 决策解
# 若 §0 选保留上游名，此处无需改名
npm run build                    # v3 构建体系：node scripts/build.mjs all（≈等价）
node scripts/test.mjs unit       # 593 passed 为基线
node scripts/typecheck.mjs
```

## 2. dsh-deploy 侧同步（仅当 §0 保留上游名）

| 文件 | 改什么 |
|---|---|
| `profile/cordis.patch.template.yml:45` | `name: '@dsh-external/dsh-blender-plugin'` → `'dsh-blender-plugin'` |
| `install/install-profile.sh:132` | 软链目录名 `@dsh-external/dsh-blender-plugin` → `dsh-blender-plugin` |
| `redeploy.sh` | 同上的包名引用（grep `@dsh-external` 全量核对） |

同步后重装 profile：`bash install/install-profile.sh`（软链目标目录本身可继续用 `/root/dsh/dsh-blender-plugin-review`，目录名不必等于包名）。

## 3. apply.sh 与两个旧 patch 的处置

`dsh-deploy/plugins/blender-plugin-delta/{fork-delta,local-improvements}.patch` 写的是 v2 扁平布局
（`runtime/engine.mjs` / `runtime/server.mjs` / `src/index.ts` 单体），在 v3 上必然 `patch does not apply`，
且现役分支比它们还多 10 个直接提交（qc/presets/win/tests/errText）从未入 patch。两个选项：

- **A（推荐）patch 退役，改分支式**：apply.sh 删掉 ②③ 两步，改为"确保工作树在
  `port/v3.0.5-delta`（或其后续集成分支）+ `npm run build`"；插件仓保持"上游 v3 + 最小必要 fork = 一个分支"。
- B 以 port 分支为源重生成两份 patch       —— 但 patch 会越攒越大，违背"插件仓贴上游"的初衷。

## 4. 真机验证清单（重启前能跑的 + 重启后必须跑的）

重启前（现役 v2.6.2 仍服务，只验磁盘产物）：
- `npm run build` 后再跑一次 `node scripts/test.mjs unit python`
- `bash dsh-deploy/selftest-deploy.sh`（仓库自洽 + addon 双份副本一致性）

重启后（切到 v3 基底，重点验移植的三处 delta）：
1. `curl -sS http://127.0.0.1:9877/doctor` → `kind=ok`；`blender_rt_plan(op="catalog")` → **34 family / 228 op**
2. **delta ①**：实例模式下每个容器 backend 对 myte 可见（选中/集合下发 OK）= `DSH_BLENDER_HTTP_HOST=0.0.0.0` 注入生效
3. **delta ②**：`blender_rt_see` / `frame` 在会话级容器里出图（旧 bug 现象是 502，ENOENT 读不回）
4. **delta ③**：`blender_viewport(op="instance", action="status")`；同一会话两次调用只复用一个实例；跨会话不串场景；租约 409 正常
5. qc_render 的 `engine` / `engine_scene_after` 字段、presets MAT 点路径（含中文名材质）、win32 spawn（本机 Linux 跳过）

## 5. 回滚预案（切流后 5 分钟内可退）

```bash
cd /root/dsh/dsh-blender-plugin-review
git checkout backup/pre-v3-port-2026-11-04   # = 现役 15e413f 原状
npm run build
bash /root/dsh/dsh-deploy/restart-dsh.sh      # 唯一重启入口（AI turn 内会自动延后 detached）
```
- worktree `/root/dsh/plugin-port-v3` 保留原样，回滚后仍可随时回到 `port/v3.0.5-delta` 继续。
- 若切流前改过 profile/软链名，回滚时一并还原（见 §2 表）。

## 6. 已知残留

- `lifecycle-config.test.ts` 一条既有失败：读 `/root/.dsh/dsh-blender.config.json` 期望 127.0.0.1、
  实得容器 IP。**与移植无关**（pristine v3.0.5 复现同样失败），集成时不必修，但别当成回归。
- `LAST_ROUTE_ERROR` 是模块级状态，14 处文案共用：并发场景"原因"可能来自相邻一次失败
  （只影响失败展示，不参与路由决策）。与 fork 原实现一致。
- 移植过程中 `sync_counts` 真实刷写过 `docs/操作教程.md` 一处计数（217→228），属预期，评审勿回退。
