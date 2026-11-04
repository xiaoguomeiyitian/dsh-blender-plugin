// 入参形状还原（移植 v2.6.3 · issue #47）。
//
// 宿主把工具参数交给 provider 时，`type:"json"`（无类型）的入参会被 provider **字符串化编码**：
//   · 数组        → {"item": [...]}（单元素数组被展平成 {"item": 元素}）
//   · 数字/布尔  → 字符串（"1.2" / "true" / "false"）
//   · 对象        → 保持字典（其值递归编码）
// 实测后果：plan/perf/opt/loop/cmd/headless 的数字、布尔、数组参数全被改写，
//   op 收到的类型不对 ⇒ "min_mm 需要数字，收到 '1.2'" / "对象不存在：item" / dry_run=false 变 true。
// 对照实验：声明了具体类型的参数（todo_write.todos / browser.fill_form.fields）原样送达 ⇒
//   根因是"无类型 JSON 参数"，不是 harness 解析。
//
// 这里在**入参边界**统一还原（后端 server 的 body 解析 + planCall 各调一次）：
//   · {"item": X} → X（X 是列表则原样；X 是标量则包成 [X]）—— 只有数组会被包 item，
//     所以标量参数不会被误还原成列表。
//   · "1.2" → 1.2 / "true" → true —— 只认**规范数字字面量**与精确的 true/false，
//     路径 / 名字 / 代码 / 尺寸字符串（"480x270"）原样保留。
// 幂等：已经是对的类型再过一次不变（provider 若哪天直接发真 JSON，也不受影响）。

const NUM_LITERAL_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

export function restoreProviderShape(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(restoreProviderShape)
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>)
    if (keys.length === 1 && keys[0] === 'item') {
      const inner = restoreProviderShape((v as Record<string, unknown>).item)
      return Array.isArray(inner) ? inner : [inner]
    }
    const out: Record<string, unknown> = {}
    for (const k of keys) out[k] = restoreProviderShape((v as Record<string, unknown>)[k])
    return out
  }
  if (typeof v === 'string') {
    const s = v.trim()
    if (s === 'true') return true
    if (s === 'false') return false
    if (s !== '' && NUM_LITERAL_RE.test(s)) {
      const n = Number(s)
      if (Number.isFinite(n)) return n
    }
  }
  return v
}
