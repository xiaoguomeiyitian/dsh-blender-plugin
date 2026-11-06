// 失败文案取值（工具层专用，与 HTTP 传输解耦）。
//
// ⚠️ 为什么独立成模块：上游 v3.0.6 的工具层回归测试会把 `src/host/http.js`
//    **整体 mock 掉**（只留 backendJson / backendPost）⇒ 取文案若从 http.js 导入，
//    在那些测试里会是 undefined ⇒ 工具直接抛错。
//    ⇒ 文案取值放到本模块（无传输依赖），http.js 再导出它以兼容旧引用。
//
// 取值顺序（issue #47 同族）：顶层 error → result.error（+ sig_hint 签名提示）→
// detail → message → raw → fallback。**真因常嵌在 result.error 里** ⇒ 只看顶层
// 会把「参数不匹配」等失败显示成 unknown。
import { isRecord, text } from '../contracts/dynamic.js'

export function backendErrorText(r: unknown, fallback = 'unknown'): string {
  if (!isRecord(r)) return fallback
  const top = r.error != null ? text(r.error) : ''
  const res = isRecord(r.result) ? r.result : null
  const inner = res && res.error != null ? text(res.error) : ''
  const detail = r.detail != null ? text(r.detail) : ''
  const sig = res && res.sig_hint != null ? text(res.sig_hint) : ''
  const msg = r.message != null ? text(r.message) : ''
  const raw = r.raw != null ? text(r.raw) : ''
  const hint = sig ? '（签名：' + sig.slice(0, 400) + '）' : ''
  return top || inner + hint || detail || msg || raw || fallback
}

/**
 * 旧名（/act 语境）保留为别名 —— 已有契约测试与外部调用仍按 actErrorText 引用。
 * @deprecated 新代码请用 {@link backendErrorText}（它对所有工具通用）。
 */
export const actErrorText = backendErrorText
