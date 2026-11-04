/**
 * fork delta ③：**会话级一次性实例路由**（v2.6.2 的 src/index.ts 单体实现 → v3 host 层）。
 *
 * **为什么**：HOLDER 是**进程级**（plugin-pid-<pid>）⇒ 同一 DSH 进程内所有会话共用同一个
 * 写租约身份 ⇒ 会话 A 的写操作不会被会话 B 挡住 ⇒ 并发写**静默互相覆盖**；再叠加场景 /
 * 主线程 / 容器都是全局单点 ⇒ 多会话并行必然打架。
 *
 * **怎么改**：按会话分配实例。宿主 ToolExecution 的 `agent.id` 就是 SessionId，用它去
 * **实例管理器**要一个专属实例（容器 + 后端 + 工作目录 + 端口）；此后本次调用的一切后端
 * 请求都打到那个实例，租约 holder 改成 `inst-<instanceId>`（真正的会话身份）。
 *
 * **零调用点改动**：所有工具都经 host/http.ts 的四个出口（backendJson / backendPost /
 * fetchFrame / fetchView）出去，只要在这几个**出口**把端口与 holder 换成"本会话实例"的，
 * 就不必改 35 处调用点。
 *
 * **不许失明**：管理器没起 / 建实例失败 ⇒ 回退旧单例（LEGACY_PORT + 旧 HOLDER），并把
 * 失败原因带在回执里（lastRouteError / routeNote）；绝不因为路由失败就让会话直接不可用。
 *
 * 本模块**故意不 import host/backend/index.js**（那里要 import 本模块做 ensureBackend 的
 * 实例分支）—— 自成一体，只有 node 内置 + constants + contracts + exec-context 四个依赖。
 */
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { HOLDER } from '../constants.js'
import { errorMessage, isRecord, text } from '../contracts/dynamic.js'
import { execInstanceName, execSignal, execSessionId } from './exec-context.js'

/** 路由解析结果：本次调用该打哪个后端、用哪个 holder。 */
export interface RouteTarget {
  port: number
  holder: string
  instanceId: string | null
  routed: boolean
  error?: string
  /** 路由备注（例如"指定的实例不存在，已改用本会话实例"） */
  note?: string
}

let INSTANCE_MODE = false
let MANAGER_URL = 'http://127.0.0.1:9880'
/** 旧单例端口（回退用；apply() 里写入实际端口） */
let LEGACY_PORT = 0
/** 最近一次路由失败原因（回执里带给用户，不静默） */
let LAST_ROUTE_ERROR = ''
/** 管理器自愈只试一次（失败后本轮不再拉，避免每 15 s 看护都去拉） */
let MANAGER_SPAWN_TRIED = false

/** 回退端口：apply() 配置过就用配置值；未配置（测试/异常路径）时退回与 backend 同源的解析。 */
function legacyPort(): number {
  if (LEGACY_PORT > 0) return LEGACY_PORT
  const env = Number(process.env.DSH_BLENDER_HTTP_PORT)
  return Number.isFinite(env) && env > 0 ? env : 9877
}

/**
 * apply() 入口调用：开启/关闭会话级实例模式。
 * @param cfgIn 插件配置（instanceMode / instanceManagerUrl）
 * @param port 旧单例端口（实例模式下的回退目标）
 */
export function setInstanceMode(cfgIn: Record<string, unknown>, port: number): void {
  INSTANCE_MODE = cfgIn.instanceMode === true
  MANAGER_URL =
    text(cfgIn.instanceManagerUrl) ||
    process.env.DSH_BLENDER_INSTANCE_MANAGER ||
    'http://127.0.0.1:9880'
  LEGACY_PORT = port
}

export function isInstanceMode(): boolean {
  return INSTANCE_MODE
}
export function managerUrl(): string {
  return MANAGER_URL
}
/** 最近一次路由失败原因（管理器原话；给"后端不可用"文案用，不静默吞掉） */
export function lastRouteError(): string {
  return LAST_ROUTE_ERROR
}

/**
 * 后端不可用时的统一文案（移植 v2.6.3 · issue #49）—— **必须带上路由失败的原因**。
 *
 * 现场（2026-10-31 真机）：实例刚被空闲回收 ⇒ 管理器建新实例时因"宿主可用内存不足"失败
 * ⇒ 旧文案只说"后端不可用（127.0.0.1:9877）"，把管理器那句清楚的错误
 * （"剩 642MB < 需要的 700MB"）整个吞掉 ⇒ 用户只能猜、只能靠重试碰运气。
 * ⇒ 现在把 LAST_ROUTE_ERROR（管理器原话）带出来。hint 仍由各工具走 toolError 的
 * next_action（v3 的信封契约），所以这里只管"消息 + 原因"。
 */
export function backendUnavailableText(port: number): string {
  const why = LAST_ROUTE_ERROR ? ' · 原因：' + LAST_ROUTE_ERROR : ''
  return '后端不可用（127.0.0.1:' + String(port) + '）' + why
}

/** 本会话自己的实例键（宿主 ToolExecution：agent.id = SessionId） */
function routeKey(): string {
  return execSessionId()
}

/** 调实例管理器（HTTP；管理面与数据面分离，管理器挂了也不影响旧单例）。
 *  导出给 viewport 的 op="instance" 运维面用（list / claim / release / reap）。 */
export async function managerFetch(
  pathname: string,
  body?: unknown,
  timeoutMs = 120000,
): Promise<Record<string, unknown>> {
  try {
    const ext = execSignal()
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = ext ? AbortSignal.any([ext, timeout]) : timeout
    const r = await fetch(MANAGER_URL + pathname, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    const t = await r.text()
    try {
      const parsed: unknown = JSON.parse(t)
      if (isRecord(parsed)) return parsed
      return { ok: false, error: 'bad json: ' + t.slice(0, 200) }
    } catch {
      return { ok: false, error: 'bad json: ' + t.slice(0, 200) }
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}

/**
 * 管理器自愈：连不上 ⇒ 拉起一个再等它就绪（最多 10 秒）。
 * 为什么要：实例模式是**默认路径**（旧单例只是回退），管理器一挂所有会话就失去实例；
 * 让插件顺手把管理器拉回来，比让用户手动重启 DSH 靠谱。
 */
async function ensureManager(): Promise<boolean> {
  const h = await managerFetch('/health', undefined, 3000)
  if (h && h.ok) return true
  if (MANAGER_SPAWN_TRIED) return false
  MANAGER_SPAWN_TRIED = true
  try {
    const script = String(
      process.env.DSH_BLENDER_INSTANCE_MANAGER_SCRIPT ||
        '/root/dsh/dsh-deploy/manager/manager.mjs',
    )
    if (!existsSync(script)) return false
    const c = spawn(process.execPath, [script, 'serve'], { stdio: 'ignore', detached: true })
    c.unref()
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500))
      const h2 = await managerFetch('/health', undefined, 2000)
      if (h2 && h2.ok) {
        MANAGER_SPAWN_TRIED = false
        return true
      }
    }
  } catch {
    /* 拉不起来就走回退 */
  }
  return false
}

/** 本会话自己的实例（ensure=true 时惰性创建） */
async function routeOwnInstance(
  key: string,
  ensure: boolean,
  back: number,
): Promise<RouteTarget> {
  const r0 = await managerFetch('/instances', { sessionId: key, ensure })
  let inst = isRecord(r0.instance) ? r0.instance : null
  if (!inst) {
    // 管理器可能压根没在跑 ⇒ 自愈一次（拉起 + 等就绪）再重试
    await ensureManager()
    const r1 = await managerFetch('/instances', { sessionId: key, ensure })
    inst = isRecord(r1.instance) ? r1.instance : null
    if (!inst) {
      LAST_ROUTE_ERROR =
        '实例管理器不可用或建实例失败：' +
        String((r1 && (r1.error || 'no instance')) || 'unknown')
      return {
        port: back,
        holder: HOLDER,
        instanceId: null,
        routed: false,
        error: LAST_ROUTE_ERROR,
      }
    }
    return {
      port: Number(inst.port),
      holder: 'inst-' + text(inst.id),
      instanceId: text(inst.id),
      routed: true,
    }
  }
  LAST_ROUTE_ERROR = ''
  return { port: Number(inst.port), holder: 'inst-' + text(inst.id), instanceId: text(inst.id), routed: true }
}

/**
 * 解析本次调用该打哪个后端。
 * @param ensure true=没有就建一个（惰性启动）；false=只查不建
 * @param fallbackPort 单例回退端口。**必须由调用方（出口）传入本次上下文的 port** —— 
 *   模块级的 LEGACY_PORT 会被任何一次 apply() 改写（测试里" backend 不可达"用例就会
 *   用封闭端口 apply 一次），拿它当权威端口会把后续所有出口打到那个已关闭的端口上。
 *
 * 显式 `instance` 参数的语义（2026-10-26 修正，v2.6.2 实测教训）：**这是"要跟哪个实例
 * 说话"，不是"再造一个会话"**。旧实现把它当成会话键去 ensure ⇒ 传一个没见过的值就会
 * **静默开一个新容器**（一个会话开出两个 Blender 容器，白吃 570MB 内存）。现在：按
 * **实例 ID** 定位；找不到就**回落本会话自己的实例**，绝不凭空多开容器。
 */
export async function routeTarget(ensure = true, fallbackPort?: number): Promise<RouteTarget> {
  const back = fallbackPort !== undefined ? fallbackPort : legacyPort()
  if (!INSTANCE_MODE) {
    return { port: back, holder: HOLDER, instanceId: null, routed: false }
  }
  const key = routeKey()
  if (!key) {
    LAST_ROUTE_ERROR = '本次调用取不到会话身份（exec.agent.id 为空）'
    return {
      port: back,
      holder: HOLDER,
      instanceId: null,
      routed: false,
      error: LAST_ROUTE_ERROR,
    }
  }
  const explicit = execInstanceName()
  if (explicit) {
    const rx = await managerFetch('/instances?id=' + encodeURIComponent(explicit))
    const byId = isRecord(rx.instance) ? rx.instance : null
    if (byId && byId.id) {
      LAST_ROUTE_ERROR = ''
      return {
        port: Number(byId.port),
        holder: 'inst-' + text(byId.id),
        instanceId: text(byId.id),
        routed: true,
      }
    }
    // 没找到 ⇒ 继续按本会话路由（ensure 时建本会话的实例），并在回执里说明回落
    const own = await routeOwnInstance(key, ensure, back)
    if (own.routed) {
      own.note = '指定的实例 ' + explicit + ' 不存在，已改用本会话实例 ' + String(own.instanceId)
      LAST_ROUTE_ERROR = own.note
    }
    return own
  }
  return await routeOwnInstance(key, ensure, back)
}

/** 路由说明（一行；给回执/日志用） */
export function routeNote(t: RouteTarget): string {
  if (!INSTANCE_MODE) return ''
  const base = t.routed
    ? '实例 ' + String(t.instanceId) + '（127.0.0.1:' + String(t.port) + '）'
    : '已回退旧单例（127.0.0.1:' + String(t.port) + '）：' + String(t.error || '未知原因')
  return t.note ? base + '（' + String(t.note) + '）' : base
}

/**
 * **实例模式下的超时放宽**。
 * 实例模式的第一次调用要**冷起一整个实例**（容器启动 ~20s + addon 就绪 + 后端 + doctor 复核），
 * 静态截止盖不住 ⇒ 会话第一句话就超时（而且没有产物，像是工具坏了）。
 * 这里只放宽**下界**（不足 4 分钟的一律抬到 4 分钟），大截止保持原样。
 */
export function instanceTimeout(ms: number): number {
  return INSTANCE_MODE ? Math.max(ms, 240000) : ms
}
