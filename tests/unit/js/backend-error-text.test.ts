// 回归自检：工具层取失败文案必须走 backendErrorText（issue #47 同族的**全工具**推广）。
//
// 背景（2026-11-05 真机验收，方案 B 窗口 v2.6.2 → v3.0.5）：
//   A3 验收点「blender_rt_txn(op='revert') 少传 label 要报真因、不再显示 unknown」失败 ——
//   仍显示 "TXN revert 失败 · unknown"。
//
// 根因：引擎层把「参数不匹配」等失败**正常返回**成 {ok:false, error, sig_hint}，
//   HTTP 路由再把它包成 {ok:false, op, result:{...}} ⇒ 真因在**嵌套**的 result.error。
//   而工具层写的是 text(r.error || r.raw || 'unknown') ⇒ 只看顶层 ⇒ 真因被吞成 unknown。
//   v3 早就有通用取值函数（原先叫 actErrorText，只给 /act 用），本轮把它提升为
//   backendErrorText 并在**所有**工具层调用点替换。
//
// 这个测试守住两件事：
//   ① helper 的取值顺序与 sig_hint 拼接；
//   ② 工具层不再出现「只读顶层 error」的旧写法（静态扫 src/）。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { backendErrorText, actErrorText } from '../../../src/host/http.js'

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('backendErrorText takes the real cause (all tools, not just /act)', () => {
  it('prefers the top-level error', () => {
    expect(backendErrorText({ ok: false, error: 'boom' })).toBe('boom')
  })

  it('digs into result.error — the shape the engine actually returns', () => {
    expect(
      backendErrorText({
        ok: false,
        op: 'revert',
        result: { error: "参数不匹配: t_revert() missing 1 required positional argument: 'label'" },
      }),
    ).toBe("参数不匹配: t_revert() missing 1 required positional argument: 'label'")
  })

  it('appends the function signature hint when present', () => {
    expect(backendErrorText({ result: { error: 'bad', sig_hint: 't_revert(label)' } })).toBe(
      'bad（签名：t_revert(label)）',
    )
  })

  it('falls back through detail / message / raw', () => {
    expect(backendErrorText({ detail: 'd' })).toBe('d')
    expect(backendErrorText({ message: 'm' })).toBe('m')
    expect(backendErrorText({ raw: 'stdout tail' })).toBe('stdout tail')
    expect(backendErrorText({ ok: false }, 'unknown')).toBe('unknown')
    expect(backendErrorText(null)).toBe('unknown')
  })

  it('keeps the old name working (alias)', () => {
    expect(actErrorText).toBe(backendErrorText)
    expect(actErrorText({ result: { error: 'x' } })).toBe('x')
  })
})

describe('tool layer never reads only the top-level error', () => {
  it('no source file keeps the old inline pattern', () => {
    const root = process.cwd()
    const files = tsFiles(path.join(root, 'src'))
    const offenders: string[] = []
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      // 旧写法：text(x.error || x.raw || 'unknown') / text(x.error || y.error || 'unknown')
      if (/\.error\s*\|\|\s*[A-Za-z_][A-Za-z0-9_]*\.(raw|error)\s*\|\|\s*'unknown'/.test(src)) {
        offenders.push(path.relative(root, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('the txn tool (A3 acceptance point) uses the shared helper', () => {
    const root = process.cwd()
    const src = readFileSync(path.join(root, 'src/tools/txn/execute.ts'), 'utf8')
    expect(src).toContain('backendErrorText')
    expect(src).not.toContain("'unknown'")
  })
})
