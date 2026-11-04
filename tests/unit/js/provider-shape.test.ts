// 移植 v2.6.3 的回归自检（issue #47 / #48）：入参形状还原 + montage kwargs 映射 +
// shots 默认值"软件 GL 下能跑完"。纯函数 + 静态断言，不需要 Blender / 真宿主。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { restoreProviderShape } from '../../../runtime/core/provider-shape.js'
import { montageCallArgs, montageCallCode } from '../../../runtime/core/montage-args.js'
import { SHOTS_DEFAULTS } from '../../../runtime/core/scripts.js'

describe('restoreProviderShape (issue #47 ①)', () => {
  it('unwraps the provider item wrapper for arrays', () => {
    expect(restoreProviderShape({ item: [1, 2] }), '列表原样').toEqual([1, 2])
    expect(restoreProviderShape({ item: 'only' }), '单元素被展平成标量的，要包回列表').toEqual([
      'only',
    ])
  })

  it('decodes canonical number literals and exact booleans', () => {
    expect(restoreProviderShape('1.2')).toBe(1.2)
    expect(restoreProviderShape('-3')).toBe(-3)
    expect(restoreProviderShape('.5')).toBe(0.5)
    expect(restoreProviderShape('1e3')).toBe(1000)
    expect(restoreProviderShape('true')).toBe(true)
    expect(restoreProviderShape('false')).toBe(false)
  })

  it('leaves path-likes, names, code and size strings alone', () => {
    for (const s of ['480x270', '1.2.3', '/tmp/x.png', 'Base Color', '', 'True', 'TRUE', '0x10']) {
      expect(restoreProviderShape(s), s).toBe(s)
    }
  })

  it('recurses into nested objects and is idempotent', () => {
    const raw = { a: '2', b: { item: [{ c: 'false' }] }, d: { item: 'x' } }
    const once = restoreProviderShape(raw) as Record<string, unknown>
    expect(once).toEqual({ a: 2, b: [{ c: false }], d: ['x'] })
    expect(restoreProviderShape(once), '已还原的再过一次必须不变').toEqual(once)
  })
})

describe('montage kwargs mapping (issue #47 ②)', () => {
  it('maps images→paths and keeps only signature kwargs', () => {
    expect(montageCallArgs({ images: ['a.png'], out: 'o.png', junk: 1 })).toEqual({
      paths: ['a.png'],
      out: 'o.png',
    })
    expect(montageCallArgs({ args: { images: ['a.png'], cols: 2 } })).toEqual({
      paths: ['a.png'],
      cols: 2,
    })
    expect(montageCallArgs()).toEqual({})
  })

  it('emits a JSON-serialised result so dicts never concatenate with str', () => {
    const code = montageCallCode({ images: ['a.png'] })
    expect(code).toContain('K.dsh_montage_api["montage"](**P)')
    expect(code).toContain('_json.dumps(')
    expect(code).toContain('"LOOP "')
    expect(code).not.toContain('A = K.dsh_montage_api')
  })
})

describe('backend-unavailable text carries the routing reason (issue #49)', () => {
  it('defines a shared helper in the host route layer', () => {
    const root = process.cwd()
    const src = readFileSync(path.join(root, 'src/host/instance-route.ts'), 'utf8')
    expect(src).toContain('export function backendUnavailableText')
    // 路由失败原因必须出现在文案里，不能被静默吞掉
    expect(src).toMatch(/· 原因：/)
  })

  it('every tool site uses the helper instead of a bare message', () => {
    const root = process.cwd()
    const sites = [
      'src/plan/tool.ts',
      'src/tools/cmd.ts',
      'src/tools/commands.ts',
      'src/tools/do/execute.ts',
      'src/tools/headless/execute.ts',
      'src/tools/job/execute.ts',
      'src/tools/loop/execute.ts',
      'src/tools/opt.ts',
      'src/tools/perf.ts',
      'src/tools/preset/execute.ts',
      'src/tools/see/execute.ts',
      'src/tools/txn/execute.ts',
      'src/tools/watch/execute.ts',
      'src/tools/worker/execute.ts',
    ]
    for (const rel of sites) {
      const src = readFileSync(path.join(root, rel), 'utf8')
      expect(src, rel).toContain('backendUnavailableText(port)')
      expect(src, rel).not.toContain("'后端不可用（127.0.0.1:' + String(port) + '）'")
    }
  })
})

describe('actErrorText keeps the real cause (issue #47 family)', () => {
  it('reads result.error / sig_hint / raw instead of reporting unknown', async () => {
    const { actErrorText } = await import('../../../src/host/http.js')
    expect(actErrorText({ ok: false, error: 'boom' })).toBe('boom')
    // 实测签名：真因在 result.error 里，旧写法只认 top.error ⇒ "unknown"
    expect(
      actErrorText({ ok: false, result: { error: '参数不匹配: t_revert() missing 1 required' } }),
    ).toBe('参数不匹配: t_revert() missing 1 required')
    // sig_hint 是最有用的部分，必须带上
    expect(actErrorText({ result: { error: 'bad', sig_hint: 't_revert(label)' } })).toBe(
      'bad（签名：t_revert(label)）',
    )
    expect(actErrorText({ raw: 'stdout tail' })).toBe('stdout tail')
    expect(actErrorText({ ok: false }, 'unknown')).toBe('unknown')
  })
})

describe('shots defaults survive software GL (issue #48)', () => {
  it('picks auto engine, a sane resolution and a degradation ladder', () => {
    expect(SHOTS_DEFAULTS.engine).toBe('auto')
    expect(SHOTS_DEFAULTS.res).toEqual([960, 540])
    expect(SHOTS_DEFAULTS.warmup).toBe(false)
    expect(SHOTS_DEFAULTS.per_view_budget_s).toBeLessThan(SHOTS_DEFAULTS.budget_s)
    expect(SHOTS_DEFAULTS.ladder.length).toBeGreaterThan(1)
    for (const step of SHOTS_DEFAULTS.ladder) {
      expect(step.scale).toBeLessThanOrEqual(1)
      expect(step.samples).toBeGreaterThan(0)
    }
  })

  it('both shots call sites eat SHOTS_DEFAULTS instead of hardcoding engine keep', () => {
    const root = process.cwd()
    const sites = [
      'runtime/execution/headless/script.ts',
      'runtime/execution/jobs/script/preload.ts',
    ]
    for (const rel of sites) {
      const src = readFileSync(path.join(root, rel), 'utf8')
      expect(src, rel).toContain('SHOTS_DEFAULTS')
      expect(src, rel).not.toMatch(/engine: 'keep'/)
    }
  })

  it('the shots summary reports both the used engine and the restored scene engine', () => {
    const root = process.cwd()
    const src = readFileSync(path.join(root, 'runtime/execution/headless/result.ts'), 'utf8')
    expect(src).toContain('engine_scene_after')
  })
})
