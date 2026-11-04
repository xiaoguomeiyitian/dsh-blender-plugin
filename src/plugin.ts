/**
 * dsh-blender-plugin —— host 侧生命周期与工具面装配。
 *
 * 这里只做装配：配置 schema / 看护 / 15 个工具注册 / 测试接缝。
 * 具体实现按层拆在 contracts/ host/ tools/ plan/ headless/ utils/ ui/。
 */
import { PLUGIN_VERSION } from './constants.js'
import { z, schemaResolve } from './contracts/tool.js'
import { losslessSanitize } from './contracts/lossless.js'
import { asRecord } from './contracts/dynamic.js'
import { resolveHttpPort } from './host/backend/index.js'
import { setInstanceMode } from './host/instance-route.js'
import { registerSchemaDiagnostic } from './tools/schema-diagnostic.js'
import { registerLifecycle } from './plugin-lifecycle.js'
import { registerToolSurface, registerTuiSurface } from './plugin-surfaces.js'
import { errorLine, redactSecrets, toolError } from './tools/errors.js'
import {
  BUNDLED_SKILL_DIR,
  BUNDLED_SKILL_PROVIDER,
  BUNDLED_SKILL_RANK,
  createBundledSkillProvider,
  parseSkillFrontmatter,
  readBundledSkill,
  registerBundledSkill,
} from './host/skill.js'
import { frameDedupe, resetFrameCache } from './utils/frame-cache.js'
import {
  HEADLESS_WAIT_MS,
  headlessReceipt,
  promotedReceipt,
  receiptEnvelope,
} from './headless/receipts/index.js'
import { CARD_SPECS, cardPresenters } from './ui/cards.js'
import type { HostContext } from './host/context.js'

export const name = 'dsh-blender-plugin'
export const inject = ['tools']

export interface Config {
  port: number
  autoStart: boolean
  /** v2.6.1：dsh-TUI 宿主半边（选中 chip / 页脚字段 / @ 提及 / /blender 命令）；只在有对应接缝的宿主生效 */
  tui: boolean
  /**
   * v2.6.1-fork(delta③)：**会话级一次性实例模式**。
   * 开：每个会话（exec.agent.id）自动分配专属 Blender 实例（容器 + 后端 + 工作目录 + 端口），
   *     会话之间物理隔离、用完即删；现役单例（9877/blender-dsh）降级为回退与滚动窗口。
   * 关：完全保持上游行为（单例 9877）。
   */
  instanceMode?: boolean
  /** 实例管理器地址（默认 http://127.0.0.1:9880） */
  instanceManagerUrl?: string
}

// v1.0.1+S11：z 不可用时（降级模式）不给 schema —— 宿主不会因为这里再抛一次而整体失败。
export const Config = z
  ? z.object({
      port: z.natural().default(resolveHttpPort()),
      autoStart: z.boolean().default(true),
      tui: z.boolean().default(true),
      // fork delta ③：默认 false ⇒ 完全保持上游 v3.0.5 行为（单例 9877）。
      instanceMode: z.boolean().default(false),
      instanceManagerUrl: z.string().default('http://127.0.0.1:9880'),
    })
  : undefined

export function apply(ctx: HostContext, config: Config): void {
  // v2.2.0：随包 skill 自动注册（可选能力；失败不影响工具面）。
  // 放在 degraded 分支之前 —— 即使 schemastery 解析失败、工具降级，技能内容也仍然可用。
  registerBundledSkill(ctx)

  // v1.0.1+S11（issue #10）：解析失败 ⇒ 降级但不消失（见 registerSchemaDiagnostic）。
  if (!z) {
    registerSchemaDiagnostic(ctx)
    return
  }

  // 防御性读配置：schema 正常时宿主会补默认值，但降级/宿主差异都不该让这里再抛。
  const cfgIn = asRecord(config)
  const port =
    Number.isFinite(Number(cfgIn.port)) && Number(cfgIn.port) > 0
      ? Number(cfgIn.port)
      : resolveHttpPort()
  const autoStart = cfgIn.autoStart === undefined ? true : !!cfgIn.autoStart

  // fork delta ③：会话级实例模式。INSTANCE_MODE=true ⇒ 工具出口按会话路由到专属实例
  // （容器+后端+工作目录+端口），旧单例只作为**回退**（管理器不可用时）；实例生命周期由
  // 管理器管（空闲 TTL / reap），插件不再拉旧单例、也不跑旧单例看护 —— 否则会养出一个
  // 没人用的常驻容器。必须在 TUI/看护/工具注册**之前**设定（它们各自查询实例模式）。
  setInstanceMode(cfgIn, port)

  // 注册顺序必须保持 v2.6.2：TUI → 看护/后端 effects → 15 个工具。
  // Cordis 逆序释放 effects，先注册 TUI/生命周期、后注册工具，卸载时才会先释放工具再杀后端。
  registerTuiSurface(ctx, port, cfgIn)
  registerLifecycle(ctx, port, autoStart)
  registerToolSurface(ctx, port)
}

/* ────────────────────────────────────────────────────────────────────────────
 * v0.9.4：**测试接缝**。tests/lossless_guard.mjs 直接 import 本模块，就能拿到
 *   ① 真实回执构造器（receiptEnvelope / headlessReceipt / promotedReceipt）
 *   ② 出口消毒器（losslessSanitize）
 * 然后用**宿主的真校验器**（dsh-util-values 的 snapshotJsonValue）断言：
 * "本插件任何一个回执都过得了 lossless-JSON 门"。
 * 这是把「返回通道」从"靠人记得别写 undefined"变成"机器每次回归都验"的唯一办法。
 * ──────────────────────────────────────────────────────────────────────────── */
export const __internals = {
  frameDedupe: frameDedupe,
  resetFrameCache: resetFrameCache,
  losslessSanitize: losslessSanitize,
  toolError: toolError,
  redactSecrets: redactSecrets,
  errorLine: errorLine,
  receiptEnvelope: receiptEnvelope,
  headlessReceipt: headlessReceipt,
  promotedReceipt: promotedReceipt,
  HEADLESS_WAIT_MS: HEADLESS_WAIT_MS,
  PLUGIN_VERSION: PLUGIN_VERSION,
  schemaResolve: schemaResolve,
  bundledSkill: {
    dir: BUNDLED_SKILL_DIR,
    provider: BUNDLED_SKILL_PROVIDER,
    rank: BUNDLED_SKILL_RANK,
    read: readBundledSkill,
    createProvider: createBundledSkillProvider,
    register: registerBundledSkill,
    parseFrontmatter: parseSkillFrontmatter,
  },
  cards: { specs: CARD_SPECS, presenters: cardPresenters },
}
