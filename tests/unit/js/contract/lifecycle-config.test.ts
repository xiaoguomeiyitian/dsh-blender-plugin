import { describe, expect, it } from 'vitest'
import * as plugin from '../../../../src/index'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { decideStart, probeTcp, probeHttp, waitHttp } from '../../../../runtime/backend_probe.js'
import { describeConfig } from '../../../../runtime/config.js'
import { closedPort, startFakeBackend } from '../../../helpers/fake-backend.mjs'
import { createFakeContext } from '../../../helpers/fake-context'
import { pkgPath } from '../../../helpers/pkg'

function readTree(dir: string, ext: string): string {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const full = path.join(dir, entry.name)
      return entry.isDirectory()
        ? readTree(full, ext)
        : entry.name.endsWith(ext)
          ? fs.readFileSync(full, 'utf8')
          : ''
    })
    .join('\n')
}
const indexSource = readTree(pkgPath('src'), '.ts')
const engineSource = [
  readTree(pkgPath('runtime', 'execution', 'workers'), '.ts'),
  readTree(pkgPath('runtime', 'core', 'engine'), '.ts'),
].join('\n')
const addonSource = readTree(pkgPath('addon', 'dsh_blender_bridge'), '.py')
const serverSource = readTree(pkgPath('runtime', 'http'), '.ts')

describe('backend start decision table', () => {
  it('prefers a listening port over a stale child handle', () => {
    expect(decideStart({ portUp: true, childAlive: false })).toBe('already-running')
    expect(decideStart({ portUp: true, childAlive: true })).toBe('already-running')
    expect(decideStart({ portUp: false, childAlive: true })).toBe('stale-handle')
    expect(decideStart({ portUp: false, childAlive: false })).toBe('spawn')
  })

  it('probes TCP and HTTP with bounded timeouts', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as any
    try {
      expect(await probeTcp('127.0.0.1', addr.port, 500)).toBe(true)
      expect(await probeHttp('http://127.0.0.1:' + addr.port + '/health', 500)).toBe(true)
      expect(await waitHttp('http://127.0.0.1:' + addr.port + '/health', 1500, 50)).toBe(true)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
    const dead = await closedPort()
    expect(await probeTcp('127.0.0.1', dead, 200)).toBe(false)
    expect(await probeHttp('http://127.0.0.1:' + dead + '/health', 200)).toBe(false)
    expect(await waitHttp('http://127.0.0.1:' + dead + '/health', 150, 50)).toBe(false)
  })
})

describe('configuration contract', () => {
  /**
   * 在**洁净环境**里取配置：清掉全部 DSH_BLENDER_* 变量 + 指向不存在的配置文件。
   *
   * 为什么必须洁净：直接 import 配置模块时，它会读**现场**配置
   * （$DSH_BLENDER_CONFIG → 包根/dsh-blender.config.json → ~/.dsh/dsh-blender.config.json）。
   * 部署机上那份写着容器 IP（addonHost=172.18.0.3、addonPort=19876）⇒
   * "发布的是文档默认值" 这条断言在部署机上必红，而它跟代码对不对毫无关系
   * （单元测试必须自足，不能依赖运行现场）。
   */
  function configInCleanEnv(extraEnv: Record<string, string> = {}): {
    cfg: Record<string, unknown>
    summary: Record<string, unknown>
  } {
    const code =
      'import(' +
      JSON.stringify(pathToFileURL(pkgPath('lib', 'runtime', 'config.js')).href) +
      ').then(m => console.log(JSON.stringify({ cfg: { host: m.CFG.addonHost, addonPort: m.CFG.addonPort, httpPort: m.CFG.httpPort, leaseTtlMs: m.CFG.leaseTtlMs, workerPort: m.CFG.workerPort, holder: m.CFG.holder }, summary: m.describeConfig() })))'
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of Object.keys(env)) {
      if (key.startsWith('DSH_BLENDER_')) delete env[key]
    }
    // 配置文件有**三条来源**：$DSH_BLENDER_CONFIG → <包根>/dsh-blender.config.json
    // → ~/.dsh/dsh-blender.config.json。指空第一条只会顺延到下一条 ⇒
    // 要拿到纯默认值，得把 HOME 也指到临时目录（否则读到现场那份容器 IP）。
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-t14-home-'))
    env.DSH_BLENDER_CONFIG = pkgPath('tmp', 'does-not-exist.json')
    env.HOME = home
    try {
      const raw = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
        encoding: 'utf8',
        env: { ...env, ...extraEnv },
      })
      return JSON.parse(raw.trim().split('\n').pop()!)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }

  it('publishes the documented defaults', () => {
    const { cfg, summary } = configInCleanEnv()
    expect(cfg.host).toBe('127.0.0.1')
    expect(cfg.addonPort).toBe(9876)
    expect(cfg.httpPort).toBe(9877)
    expect(cfg.leaseTtlMs).toBe(600000)
    expect(cfg.workerPort).toBe(9879)
    expect(summary.addon).toBe('127.0.0.1:9876')
    expect(summary.http).toBe('127.0.0.1:9877')
    expect(summary.leaseTtlMs).toBe(600000)
    expect(summary.workerPort).toBe(9879)
  })

  it('lets the command-line port override the summary only', () => {
    // describeConfig 是纯函数（只吃显式入参）⇒ 与现场配置无关
    expect(describeConfig({ httpPort: 19999 }).http).toBe('127.0.0.1:19999')
    // 洁净环境下读到的仍是文档默认值
    expect(configInCleanEnv().summary.http).toBe('127.0.0.1:9877')
  })

  it('reads a config file when no environment override is present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-t14-config-'))
    const file = path.join(dir, 'dsh-t14-config.json')
    fs.writeFileSync(file, JSON.stringify({ httpPort: 19876, workerPort: 19877 }), 'utf8')
    try {
      const code =
        'import(' +
        JSON.stringify(pathToFileURL(pkgPath('lib', 'runtime', 'config.js')).href) +
        ').then(m => console.log(JSON.stringify({ http: m.CFG.httpPort, worker: m.CFG.workerPort })))'
      const raw = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
        encoding: 'utf8',
        env: { ...process.env, DSH_BLENDER_CONFIG: file },
      })
      expect(JSON.parse(raw.trim().split('\n').pop()!)).toEqual({ http: 19876, worker: 19877 })
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (e) {}
    }
  })

  it('falls back to defaults for invalid numeric overrides', () => {
    const code =
      'import(' +
      JSON.stringify(pathToFileURL(pkgPath('lib', 'runtime', 'config.js')).href) +
      ').then(m => console.log(JSON.stringify({ addon: m.CFG.addonPort, http: m.CFG.httpPort, ttl: m.CFG.leaseTtlMs })))'
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_BLENDER_CONFIG: pkgPath('tmp', 'does-not-exist.json'),
        DSH_BLENDER_ADDON_PORT: 'not-a-port',
        DSH_BLENDER_HTTP_PORT: '-1',
        DSH_BLENDER_LEASE_TTL_MS: 'NaN',
      },
    })
    expect(JSON.parse(raw.trim().split('\n').pop()!)).toEqual({
      addon: 9876,
      http: 9877,
      ttl: 600000,
    })
  })

  it('honors every DSH_BLENDER_* environment override', () => {
    const code =
      'import(' +
      JSON.stringify(pathToFileURL(pkgPath('lib', 'runtime', 'config.js')).href) +
      ').then(m => console.log(JSON.stringify({ cfg: { host: m.CFG.addonHost, addonPort: m.CFG.addonPort, httpPort: m.CFG.httpPort, leaseTtlMs: m.CFG.leaseTtlMs, workerPort: m.CFG.workerPort, holder: m.CFG.holder }, summary: m.describeConfig() })))'
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_BLENDER_CONFIG: pkgPath('tmp', 'does-not-exist.json'),
        DSH_BLENDER_ADDON_HOST: '127.0.0.2',
        DSH_BLENDER_ADDON_PORT: '19996',
        DSH_BLENDER_HTTP_PORT: '19995',
        DSH_BLENDER_LEASE_TTL_MS: '1234',
        DSH_BLENDER_WORKER_PORT: '19994',
        DSH_BLENDER_HOLDER: 'test-holder',
      },
    })
    const out = JSON.parse(raw.trim().split('\n').pop()!)
    expect(out.cfg).toMatchObject({
      host: '127.0.0.2',
      addonPort: 19996,
      httpPort: 19995,
      leaseTtlMs: 1234,
      workerPort: 19994,
      holder: 'test-holder',
    })
    expect(out.summary.addon).toBe('127.0.0.2:19996')
    expect(out.summary.http).toBe('127.0.0.1:19995')
  })
})

describe('backend lifecycle operations', () => {
  it('keeps v2.6.2 apply order: lifecycle effects before the 15 tools', () => {
    const f = createFakeContext()
    plugin.apply(f.ctx, { autoStart: false, tui: false, port: 9898 })
    const watchdog = f.events.indexOf('effect:dsh-blender-plugin: watchdog')
    const backend = f.events.indexOf('effect:dsh-blender-plugin: backend')
    const firstTool = f.events.findIndex((e) => e.startsWith('tool:'))
    expect(watchdog).toBeGreaterThanOrEqual(0)
    expect(backend).toBeGreaterThan(watchdog)
    expect(firstTool).toBeGreaterThan(backend)
    f.dispose()
  })

  it('re-registers all 15 tools after a host dispose and reload', () => {
    const first = createFakeContext()
    plugin.apply(first.ctx, { autoStart: false, tui: false, port: 9898 })
    expect(first.tools).toHaveLength(15)
    first.dispose()
    const second = createFakeContext()
    plugin.apply(second.ctx, { autoStart: false, tui: false, port: 9898 })
    expect(second.tools).toHaveLength(15)
    second.dispose()
  })

  it('starts against an existing backend, pauses on stop, and restarts in place', async () => {
    const backend = await startFakeBackend()
    const f = createFakeContext()
    plugin.apply(f.ctx, { autoStart: false, tui: false, port: backend.port })
    const viewport = f.tools.find((t) => t.name === 'blender_viewport')!
    try {
      const started = await (viewport.execute as any)({ op: 'start' }, {})
      expect(started).toContain('后端已在运行')
      const stopped = await (viewport.execute as any)({ op: 'stop' }, {})
      expect(stopped).toContain('看护已暂停')
      const restarted = await (viewport.execute as any)({ op: 'restart' }, {})
      expect(restarted).toContain('后端已重启')
    } finally {
      f.dispose()
      await backend.close()
    }
  }, 15000)
})

describe('lifecycle source contract', () => {
  it('keeps the watchdog cadence, two-miss threshold, and lease heartbeat', () => {
    expect(indexSource).toContain('setInterval')
    expect(indexSource).toContain('15000')
    expect(indexSource).toContain('probeMisses >= 2')
    expect(indexSource).toContain('renewOnly: true')
    expect(indexSource).toContain('SIGKILL')
    expect(indexSource).toContain('backend')
  })

  it('reaps idle workers after the 15 minute default', () => {
    expect(engineSource).toContain('DSH_WORKER_TTL_MS')
    expect(engineSource).toContain('900000')
    expect(engineSource).toContain('workerReaper')
  })

  it('stops the addon server and removes handlers on unregister', () => {
    expect(addonSource).toContain('def unregister():')
    expect(addonSource).toContain('bpy.types.dshbb_server.stop()')
    expect(addonSource).toContain('unregister_activity_handlers()')
  })

  it('reclaims a dead port and exits cleanly when the holder answers', () => {
    expect(serverSource).toContain("code === 'EADDRINUSE'")
    expect(serverSource).toContain('reclaimTries < 2')
    expect(serverSource).toContain('process.exit(0)')
    expect(serverSource).toContain('SIGTERM')
    expect(serverSource).toContain('SIGKILL')
    expect(serverSource).toContain("process.on('SIGTERM', shutdown)")
  })
})
