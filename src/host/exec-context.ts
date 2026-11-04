import { AsyncLocalStorage } from 'node:async_hooks'

export interface ExecContextStore {
  signal?: AbortSignal
  /** fork delta ③：宿主 ToolExecution 的 caller agent（agent.id = SessionId） */
  agent?: unknown
  /** fork delta ③：本次调用 JSON-normalized 后的入参（读 arguments.instance） */
  arguments?: unknown
}

// v0.9.2（DSH 更新适配 R3）：把宿主的 exec（exec.signal = 用户打断 / per-tool 截止）
// 放进 AsyncLocalStorage，传输层 withTimeout() 自动合并它 —— **15 个工具体一行不改**
// 就能响应宿主取消；每个工具另补静态 timeoutMs（见 T），把"上游设默认截止"从
// "Blender 还在跑、工具已被判超时"的静默错位，变成"先由本插件给出可读错误"。
// v2.6.1-fork(delta③)：agent / arguments 一并入库 —— 实例路由按 exec.agent.id 分配
// 会话专属实例，并按 arguments.instance 做"按 ID 定位"。
export const EXEC_CTX = new AsyncLocalStorage<ExecContextStore>()
/** 当前工具调用对应的宿主 exec.signal（没有则 undefined） */
export function execSignal(): AbortSignal | undefined {
  const s = EXEC_CTX.getStore()
  return s?.signal instanceof AbortSignal ? s.signal : undefined
}
/** 本次工具调用的会话身份（宿主 ToolExecution：agent.id = SessionId） */
export function execSessionId(): string {
  const s = EXEC_CTX.getStore()
  const a = s ? s.agent : undefined
  const agent = a && typeof a === 'object' ? (a as Record<string, unknown>) : null
  return agent && agent.id ? String(agent.id) : ''
}
/** 本次工具调用显式指定的实例（可选）
 *
 *  ⚠️ 语义（2026-10-26 修正）：**这是"要跟哪个实例说话"，不是"再造一个会话"**。
 *  旧实现把它当成会话键去 ensure ⇒ 传一个没见过的值就会**静默开一个新容器**
 *  （实测踩中：模型从实例列表里抄了个实例 ID 传回来 ⇒ 一个会话开出两个 Blender 容器，
 *   白吃 570MB 内存）。现在：按**实例 ID** 定位；找不到就**回落本会话自己的实例**，
 *   绝不凭空多开容器。
 */
export function execInstanceName(): string {
  const s = EXEC_CTX.getStore()
  const ar = s ? s.arguments : undefined
  if (!ar || typeof ar !== 'object') return ''
  return String((ar as Record<string, unknown>).instance || '')
}
