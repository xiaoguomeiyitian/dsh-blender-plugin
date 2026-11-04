/** blender_viewport 的执行层：op 分发 + 每个 op 一个阶段函数（行为与 v2.6.2 一致）。 */
import { HOLDER, SERVER_PATH } from '../../constants.js'
import {
  base,
  killBackendByCmd,
  killChildHandle,
  setPaused,
  sleep,
  startBackend,
} from '../../host/backend/index.js'
import { backendJson, backendPost } from '../../host/http.js'
import {
  isInstanceMode,
  lastRouteError,
  managerFetch,
  managerUrl,
  routeNote,
  routeTarget,
} from '../../host/instance-route.js'
import { execSessionId } from '../../host/exec-context.js'
import { probeHttp, waitHttp } from '../../host/runtime-bridge.js'
import { asArray, asRecord, errorMessage, isRecord, text } from '../../contracts/dynamic.js'
import {
  formatDoctor,
  formatLaunch,
  formatLeaseError,
  formatLeaseResult,
  formatStatus,
  formatStatusError,
  formatWho,
} from './presenter.js'

export async function executeViewport(
  args: Record<string, unknown>,
  port: number,
): Promise<string> {
  const op = text(args.op) || 'status'
  if (op === 'instance') return opInstance(args)
  if (op === 'start') return opStart(port)
  if (op === 'restart') return opRestart(port)
  if (op === 'stop') return opStop(port)
  if (op === 'who' || op === 'lease' || op === 'release') return opLease(op, args, port)
  if (op === 'launch') return opLaunch(args, port)
  if (op === 'doctor') return opDoctor(port)
  return opStatus(port)
}

/**
 * fork delta ③：会话级实例运维面（op="instance"）。
 * 实例模式下，"后端"不再是全局单例，而是**本会话的实例**（容器+后端+工作目录+端口）。
 * 这里给出实例的可见面：status / claim（建一个）/ list（看全部）/ release（删本会话）/ reap。
 */
async function opInstance(args: Record<string, unknown>): Promise<string> {
  const action = text(args.action) || 'status'
  const key = execSessionId()
  const mgr = '实例管理器 ' + managerUrl()
  const why = lastRouteError() ? ' · 原因：' + lastRouteError() : ''
  if (!isInstanceMode()) {
    return (
      '当前是**单例模式**（instanceMode=false）：没有会话级实例，工具仍打旧单例。\n' +
      '要启用：插件配置 instanceMode=true（或环境 DSH_BLENDER_INSTANCE_MODE=1）后重启 DSH。'
    )
  }
  if (!key) return '取不到会话身份（exec.agent.id 为空）⇒ 无法定位实例。'
  if (action === 'list') {
    const r = await managerFetch('/instances')
    const list = asArray(r.instances)
    if (!list.length) return mgr + '：当前没有实例。'
    return (
      mgr +
      '（共 ' +
      String(list.length) +
      ' 个）：\n' +
      list
        .map((i) => {
          const it = asRecord(i)
          const age = Math.round((Date.now() - Number(it.createdAt || 0)) / 1000)
          const idle = Math.round((Date.now() - Number(it.lastUsedAt || 0)) / 1000)
          return (
            '· ' +
            text(it.id) +
            '  会话=' +
            text(it.sessionId || '-') +
            '  端口=' +
            text(it.port) +
            '  容器=' +
            text(it.container) +
            '  状态=' +
            text(it.state) +
            '  存活=' +
            String(age) +
            's  空闲=' +
            String(idle) +
            's'
          )
        })
        .join('\n')
    )
  }
  if (action === 'reap') {
    const r = await managerFetch('/instances/reap', {})
    return (
      mgr +
      ' reap：' +
      JSON.stringify(asArray(r.removed)) +
      (r && r.ok ? '' : '（失败：' + String(r && r.error) + '）')
    )
  }
  if (action === 'release') {
    const targetId = text(args.instance_id) || text(args.instance)
    let id = targetId
    if (!id) {
      const r = await managerFetch('/instances?session=' + encodeURIComponent(key))
      const inst = isRecord(r.instance) ? r.instance : null
      id = inst ? text(inst.id) : ''
    }
    if (!id) return '本会话没有实例（key=' + key + '）⇒ 无需释放。'
    const r = await managerFetch('/instances/' + encodeURIComponent(id) + '/release', {})
    return '已释放实例 ' + id + '（容器已删、后端已停；产物目录保留 7 天）：' + JSON.stringify(r)
  }
  if (action === 'claim') {
    // 显式给了 instance ⇒ 按 ID 取（**不新建**）；没给 ⇒ 领本会话的实例
    const explicit = text(args.instance)
    const r = explicit
      ? await managerFetch('/instances?id=' + encodeURIComponent(explicit))
      : await managerFetch('/instances', { sessionId: key, ensure: true })
    const inst = isRecord(r.instance) ? r.instance : null
    if (!inst) {
      return explicit
        ? '找不到实例 ' +
            explicit +
            '（不会替你新建一个；先 op="instance" action="list" 看现有实例）'
        : '建实例失败：' + String((r && r.error) || 'unknown') + why
    }
    return (
      '已分配实例：' +
      text(inst.id) +
      '\n端口=' +
      text(inst.port) +
      '  容器=' +
      text(inst.container) +
      '\n工作目录=' +
      text(inst.workDir) +
      '\n会话键=' +
      key +
      (r.created ? '（新建）' : '（复用）')
    )
  }
  // status（默认）：只查不建（status 不该有副作用）
  const explicit = text(args.instance)
  const r = explicit
    ? await managerFetch('/instances?id=' + encodeURIComponent(explicit))
    : await managerFetch('/instances?session=' + encodeURIComponent(key))
  const inst = isRecord(r.instance) ? r.instance : null
  const t = await routeTarget(false)
  return (
    mgr +
    '\n会话键=' +
    key +
    '\n本会话实例=' +
    (inst
      ? text(inst.id) +
          '（端口 ' +
          text(inst.port) +
          ' · 容器 ' +
          text(inst.container) +
          ' · ' +
          text(inst.state) +
          '）'
      : '无（还没建）') +
    '\n路由=' +
    routeNote(t) +
    why
  )
}

async function opStart(port: number): Promise<string> {
  setPaused(false)
  // 实例模式："启动" = 惰性建本会话实例
  if (isInstanceMode()) {
    const t = await routeTarget(true)
    return t.routed
      ? '实例已就绪：' + String(t.instanceId) + '（127.0.0.1:' + String(t.port) + '）'
      : '建实例失败：' +
          String(t.error || 'unknown') +
          '（已回退旧单例 127.0.0.1:' +
          String(t.port) +
          '）'
  }
  const url = base(port) + '/health'
  if (await probeHttp(url, 800)) return '后端已在运行：' + base(port) + '/（看护已启用）'
  const how = await startBackend(port)
  // S7：等待改成「轮询到真能服务」（15 s），不再「睡固定窗口后探测一次」。
  if (await waitHttp(url, 15000, 300))
    return '后端已启动（' + how + '）：' + base(port) + '/（看护已启用）'
  return (
    '启动失败：' +
    how +
    '（15 s 内 /health 仍不通；可先 op=restart 清残留进程，或检查 ' +
    SERVER_PATH +
    ' 与 node）'
  )
}

async function opRestart(port: number): Promise<string> {
  setPaused(false)
  // 实例模式："重启" = 释放本会话实例后重建（换一个新容器 ⇒ 场景干净）
  if (isInstanceMode()) {
    const key = execSessionId()
    const r0 = await managerFetch('/instances?session=' + encodeURIComponent(key))
    const old = isRecord(r0.instance) ? r0.instance : null
    if (old && old.id)
      await managerFetch('/instances/' + encodeURIComponent(text(old.id)) + '/release', {})
    const t = await routeTarget(true)
    return t.routed
      ? '实例已重建：' +
          String(t.instanceId) +
          '（127.0.0.1:' +
          String(t.port) +
          '）' +
          (old ? '（旧实例 ' + String(old.id) + ' 已释放）' : '')
      : '重建失败：' + String(t.error || 'unknown')
  }
  killChildHandle()
  killBackendByCmd(port)
  await sleep(500)
  const how = await startBackend(port)
  if (await waitHttp(base(port) + '/health', 15000, 300))
    return '后端已重启（' + how + '）：' + base(port) + '/'
  return '重启失败：' + how + '（15 s 内 /health 仍不通）'
}

async function opStop(port: number): Promise<string> {
  setPaused(true)
  // 实例模式："停止" = 释放本会话实例（容器即删，产物保留 7 天）
  if (isInstanceMode()) {
    const key = execSessionId()
    const r = await managerFetch('/instances?session=' + encodeURIComponent(key))
    const inst = isRecord(r.instance) ? r.instance : null
    if (!inst || !inst.id) return '本会话没有实例（key=' + key + '）⇒ 无需停止。'
    const rr = await managerFetch('/instances/' + encodeURIComponent(text(inst.id)) + '/release', {})
    return (
      '已释放实例 ' +
      text(inst.id) +
      '（容器已删、后端已停；产物目录保留）：' +
      JSON.stringify(rr)
    )
  }
  const notes: string[] = []
  if (killChildHandle()) notes.push('child-句柄已杀')
  const killed = killBackendByCmd(port)
  if (killed.length) notes.push('残留后端已杀 pid=' + killed.join(','))
  if (!notes.length) return '没有在跑的后端（127.0.0.1:' + String(port) + '）；看护已暂停'
  await sleep(400)
  return '已停止后端：' + notes.join(' · ') + '（看护已暂停，op=start 恢复）'
}

async function opLease(
  op: 'who' | 'lease' | 'release',
  args: Record<string, unknown>,
  port: number,
): Promise<string> {
  try {
    if (op === 'who') return formatWho(await backendJson(port, '/who', 15000))
    const body: Record<string, unknown> = { holder: text(args.holder) || HOLDER }
    if (args.ttl_ms) body.ttlMs = Number(args.ttl_ms)
    if (op === 'lease' && args.force) body.force = true
    if (op === 'lease' && args.scope) body.scope = text(args.scope)
    const r = await backendPost(port, op === 'lease' ? '/lease' : '/release', body, 20000)
    if (op === 'lease' && r.error === 'leased') return formatLeaseResult(op, r)
    return (op === 'lease' ? 'LEASE ' : 'RELEASE ') + JSON.stringify(r)
  } catch (e: unknown) {
    return formatLeaseError(op, e)
  }
}

async function opLaunch(args: Record<string, unknown>, port: number): Promise<string> {
  try {
    const body: Record<string, unknown> = {}
    if (args.wait_ms) body.waitMs = Number(args.wait_ms)
    if (args.file) body.file = text(args.file)
    if (args.exe) body.exe = text(args.exe)
    if (args.addon_module) body.addonModule = text(args.addon_module)
    if (args.addon_file) body.addonFile = text(args.addon_file)
    if (args.dry_run) body.dryRun = true
    const r = await backendPost(
      port,
      '/launch',
      body,
      Math.max(30000, Number(args.wait_ms || 90000) + 30000),
    )
    return formatLaunch(r)
  } catch (e: unknown) {
    return (
      'launch 失败：' +
      errorMessage(e) +
      '（后端没起？先 blender_viewport op=start —— 那是管**后端**进程的，本 op 才是管 Blender 的）'
    )
  }
}

async function opDoctor(port: number): Promise<string> {
  try {
    return formatDoctor(await backendJson(port, '/doctor'))
  } catch (e: unknown) {
    return '体检失败：' + errorMessage(e) + '（后端可能没起：blender_viewport op=start）'
  }
}

async function opStatus(port: number): Promise<string> {
  try {
    return formatStatus(port, await backendJson(port, '/status'))
  } catch (e: unknown) {
    return formatStatusError(port, e)
  }
}
