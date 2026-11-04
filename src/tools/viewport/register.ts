/** blender_viewport 工具声明与注册（schema/参数描述是模型契约，逐字保持）。 */
import { vTool } from '../../contracts/tool.js'
import { T } from '../../constants.js'
import { instanceTimeout } from '../../host/instance-route.js'
import { executeViewport } from './execute.js'
import { renderViewportOutput } from './presenter.js'
import type { HostContext } from '../../host/context.js'

function buildViewportTool(port: number) {
  return vTool({
    name: 'blender_viewport',
    description:
      '实时通道后端（127.0.0.1:' +
      String(port) +
      '）运维入口：**status**（健康/视口区域/计数/版本）、**doctor**（bpy 往返三级体检：未连/主线程忙/addon 卡死 + 修法）、' +
      '**start / stop / restart**（后端进程与 15 s 看护）、**who / lease / release**（写租约；冲突时 409，只读 op 豁免）、' +
      '**launch**（一键拉起 GUI Blender 并 Connect addon：spawn → **轮询 addon 端口** → doctor；幂等）。' +
      'op="instance" = 会话级实例运维面（action 见参数）。' +
      '细节见 catalog(tool:viewport)。',
    parameters: {
      instance: {
        type: 'string',
        description: '实例 ID（默认本会话独占）',
      },
      op: {
        type: 'string',
        required: true,
        description:
          'status | doctor | who | lease | release | start | stop | restart | launch | instance',
      },
      action: {
        type: 'string',
        description: 'op=instance 时的子动作：status（默认） | claim | list | release | reap',
      },
      instance_id: {
        type: 'string',
        description: 'op=instance action=release 时指定要释放的实例 id（默认本会话的）',
      },
      holder: {
        type: 'string',
        description: 'lease/release 的持有者名（默认本插件进程 pid）',
      },
      ttl_ms: {
        type: 'integer',
        description: 'lease 有效期毫秒，默认 600000；写操作会自动续期',
      },
      force: {
        type: 'boolean',
        description: 'lease 时抢占别人的租约（默认 false，被占用返回 409）',
      },
      scope: {
        type: 'string',
        description:
          '【lease】写作用域：collection:COL_Lights 或 prefix:LGT-（逗号分隔）；声明式，会出现在 who/lease/409 回执',
      },
      wait_ms: {
        type: 'integer',
        description: '【launch】等 addon 端口的上限，默认 90000',
      },
      file: {
        type: 'string',
        description: '【launch】启动时打开的 .blend',
      },
      exe: { type: 'string', description: '【launch】指定 blender.exe（覆盖自动探测）' },
      addon_module: {
        type: 'string',
        description:
          '【launch】要 enable 的 addon 模块名（逗号分隔）；默认自动扫 mcp / dshbb 等模块',
      },
      addon_file: {
        type: 'string',
        description: '【launch】按文件 import 的 addon .py 路径',
      },
      dry_run: {
        type: 'boolean',
        description: '【launch】只回报将执行的命令，不真启动',
      },
    },
    output: {
      schema: { type: 'string' },
      render: renderViewportOutput,
    },
    // fork delta ③：实例模式下首次调用要冷起一整个实例 ⇒ 下界抬到 4 分钟
    timeoutMs: instanceTimeout(T.viewport),
    async execute(args: Record<string, unknown>) {
      return executeViewport(args, port)
    },
  })
}

export function registerViewport(ctx: HostContext, port: number): void {
  ctx.effect(() => ctx.tools.register(buildViewportTool(port)), 'dsh-blender-plugin: tool')
}
