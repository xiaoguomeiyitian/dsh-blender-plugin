/** 插件对外接缝装配：dsh-TUI 宿主半边与 15 个模型工具。 */
import { HOLDER } from './constants.js'
import type { HostContext } from './host/context.js'
import { isInstanceMode, managerUrl } from './host/instance-route.js'
import { registerTools } from './tools/index.js'
import { registerTuiHost } from './tui/index.js'

export function registerTuiSurface(
  ctx: HostContext,
  port: number,
  cfgIn: Record<string, unknown>,
): void {
  // dsh-TUI 宿主半边。各块按接缝是否存在启用；Web / headless 上什么都不做。
  if (cfgIn.tui !== false) {
    // fork delta ③：实例模式下 TUI 没有会话概念 ⇒ 指向管理器代理口（转发到"最近使用的实例"）。
    let tuiPort = port
    if (isInstanceMode()) {
      try {
        tuiPort = Number(new URL(managerUrl()).port || 9880)
      } catch {
        tuiPort = 9880
      }
    }
    registerTuiHost(ctx, { port: tuiPort, holder: HOLDER })
  }
}

export function registerToolSurface(ctx: HostContext, port: number): void {
  // ---------- 工具面：15 个工具按 v2.6.2 原顺序注册（各工具的 ctx.effect 键不变） ----------
  registerTools(ctx, port)
}
