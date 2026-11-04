// montage 的 kwargs 解析（移植 v2.6.3 · issue #47）—— 纯函数，可单测。
//
// 契约：runtime/py/render/montage.py 的签名是 montage(paths, cols=None, tile=…, out=None,
// labels=None, grid=None, scale_m=None)，而 catalog 骨架给的是 args={images:[…], out:"…"}
// ⇒ 必须把 images 映射成 paths，且**只**传签名认识的关键字（此前把整个 payload 当 paths
// 传 ⇒ 拼图拿到 dict）。
export const MONTAGE_KWARGS = ['paths', 'cols', 'tile', 'out', 'labels', 'grid', 'scale_m']

export function montageCallArgs(payload: unknown): Record<string, unknown> {
  let P: Record<string, unknown> =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : {}
  const inner = P.args
  if (inner && typeof inner === 'object' && !Array.isArray(inner))
    P = { ...(inner as Record<string, unknown>) }
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(P)) if (MONTAGE_KWARGS.indexOf(k) >= 0) out[k] = P[k]
  if (!out.paths && P.images) out.paths = P.images
  return out
}

/** montage 的 Python 调用体：结果必须 **JSON 化**（dict 不能与 str 相加，否则报
 * "can only concatenate str (not 'dict') to str"）。 */
export function montageCallCode(payload: unknown): string {
  const q = montageCallArgs(payload)
  return [
    'import json as _json',
    'P = _json.loads(' + JSON.stringify(JSON.stringify(q)) + ')',
    'print("LOOP " + _json.dumps(K.dsh_montage_api["montage"](**P), ensure_ascii=False, default=str))',
  ].join('\n')
}
