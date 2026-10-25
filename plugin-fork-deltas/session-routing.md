# fork delta ③：会话级一次性 Blender 实例路由

> 本文件记录本仓（fork）相对上游 `origin/main` 的**第三条本地改动**。
> ①② 见 `docs/DSH-更新适配.md`。每次 rebase 上游后，重放本 delta 并跑本文末尾的回归清单。

## 一句话

**每个会话自动分配一个专属 Blender 实例**（容器 + 后端 + 工作目录 + 端口），
会话之间物理隔离、用完即删；现役常驻单例降级为**回退路径**。

## 为什么必须改（现役的真问题）

| # | 问题 | 现役表现 | 本 delta 后 |
|---|------|----------|-----------|
| ① | **租约形同虚设** | HOLDER 是**进程级**（`plugin-pid-<pid>`）⇒ 同进程内所有会话共用一个写租约身份 ⇒ 会话 A 的写操作不会被 B 挡住 ⇒ 并发写**静默互相覆盖** | holder 变成 `inst-<instanceId>`（真正的会话身份）⇒ A 写时只会被 A 自己的实例挡住 |
| ② | 场景全局共享 | 只有一个 `workspace.blend` / 一个 addon 内核 | 每个实例一份工作目录与场景 |
| ③ | 主线程单点 | 一次长渲染阻塞所有会话 | 每个实例一个 Blender 内核 |
| ④ | 容器常驻 | 不用的会话也吃内存与 CPU（~200MB + 3–4% llvmpipe） | 惰性启动、空闲 10 分钟回收 |
| ⑤ | 跨容器回访 | addon 只能听 loopback ⇒ 靠 socat 转发 | 每实例独立 socat + **逐实例 env 注入回访端口** |

## 改了什么（`src/index.ts`）

### 1. 配置

```ts
instanceMode?: boolean            // 默认 false（= 完全保持 v2.6.1 行为）
instanceManagerUrl?: string       // 默认 http://127.0.0.1:9880
```

开启位置（DSH profile）：`/root/.dsh/profiles/web/cordis.patch.yml`
的 `@dsh-external/dsh-blender-plugin` 条目 `config:`。

### 2. 路由核心（新增在 HOLDER 之后）

| 函数 | 作用 |
|------|------|
| `execSessionId()` | 从 `EXEC_CTX.getStore()` 取 `agent.id`（= 宿主 SessionId） |
| `execInstanceName()` | 取本次调用的 `arguments.instance`（显式指定实例，可选） |
| `routeKey()` | 实例键 = 显式实例名优先，否则会话 id |
| `managerFetch()` | 调实例管理器（建/查实例） |
| `ensureManager()` | **管理器自愈**：连不上就拉起一个再等就绪（最多 10 秒） |
| `routeTarget(ensure)` | 解析本次调用该打哪个后端 + 用哪个 holder |
| `routeNote()` | 一行路由说明（回执/日志用） |

### 3. **零调用点改动**的关键：出口即路由

所有工具都经这四个出口去后端，因此只要改这四处，**35 处调用点一行不动**：

```ts
backendJson(port, path, timeoutMs, init)   // 出口：base(routeTarget().port)
backendPost(port, path, body, timeoutMs)   // 出口：base(routeTarget().port) + holder=routeTarget().holder
fetchFrame(port, size, full, area)          // 出口：base(routeTarget().port)
fetchView(port, spec, timeoutMs)            // 出口：base(routeTarget().port)
```

`ensureBackend()` / `startBackend()` 在实例模式下改为「让管理器建实例」。

### 4. 运维面

`blender_viewport` 新增 `op="instance"`：

| action | 作用 |
|--------|------|
| `status`（默认） | 本会话的实例 + 当前路由 |
| `claim` | 建本会话实例（惰性启动的显式版） |
| `list` | 列出全部实例（端口/容器/存活/空闲） |
| `release` | 释放本会话实例（容器即删，产物留 7 天） |
| `reap` | 回收空闲实例、孤儿容器、超期产物 |

`op=start/stop/restart` 在实例模式下改为「建/放/重建**本会话实例**」。

### 5. 工具参数

15 个工具都新增可选参数 `instance`（显式指定实例；默认按会话自动分配）。

## 路由失败怎么办（不许失明）

管理器不可用 / 建实例失败 ⇒ **回退旧单例**（`LEGACY_PORT` + 旧 `HOLDER`），
并把原因写进回执（`routeNote()`）。旧单例被删掉后仍回退 ⇒ 会话会看到明确的失败原因，
而不是静默失明。

## 配套（部署侧，不在本仓）

| 组件 | 位置 | 职责 |
|------|------|------|
| 实例管理器 | `/root/dsh/blender/instance/manager.mjs` | 建容器/起后端/分配端口/空闲回收/残留 reap/代理 |
| 自检 | `/root/dsh/blender/instance/manager.selftest.mjs` | 真机 20 条判据 |
| 切换脚本 | `/root/dsh/blender/instance/cutover-to-instance-mode.sh` | 验收后删旧常驻容器（带前置检查） |
| 镜像 | `blender-dsh-bridge:1.10` | 构建期启用 bridge addon ⇒ 免运行时 swap，冷启动 20s |

## 回归清单（rebase 后必跑）

```bash
npm run typecheck
npm test                                   # 注意：lease-stale 的 D2/E1/E2 为**既有失败**（与本 delta 无关）
node /root/dsh/blender/instance/manager.selftest.mjs   # 真机：20 条
```

实机验收（切换后）：`blender_viewport(op="instance", action="status")` 看本会话实例；
`blender_viewport(op="doctor")` 回 `kind=ok`；`blender_rt_see` 出一帧真 PNG；
`blender_rt_plan(op="catalog")` 仍为 **33 family / 217 op**、工具数仍为 **15**。
