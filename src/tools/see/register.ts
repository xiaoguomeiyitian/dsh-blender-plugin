/** blender_rt_see 工具声明与注册（schema/参数描述是模型契约，逐字保持）。 */
import { vTool } from '../../contracts/tool.js'
import type { HostContext } from '../../host/context.js'
import { ANY_SCHEMA } from '../schema-diagnostic.js'
import { T } from '../../constants.js'
import { instanceTimeout } from '../../host/instance-route.js'
import { renderOne } from '../../ui/cards.js'
import { executeSee } from './execute.js'

function buildSeeTool(ctx: HostContext, port: number) {
  return vTool({
    name: 'blender_rt_see',
    description:
      '【看视口】约 55–160 ms 出一帧：改一步看一眼就用它。GUI 不在或传 session 时自动走持久 worker 的 Workbench 离屏（无头也能同步看）。' +
      '给 from/look_at 等走**自定义视角**出图：自建矩阵离屏绘制，不建相机、不改 scene.camera、不动用户视口。' +
      'full=true + area=N 走整窗口截图（要看 Blender UI 时用）。回执带 coverage_estimate / frame_looks_empty 自诊断；同画面不重复附图（省 token），force=true 重发。' +
      '细节见 catalog(tool:rt_see)。',
    parameters: {
      instance: { type: 'string', description: '实例 ID（默认本会话独占）' },
      max_size: {
        type: 'integer',
        description: '最长边像素，默认 560（420 更快）',
      },
      session: { type: 'string', description: '无头 worker 会话名（不走 GUI）' },
      auto: { type: 'boolean', description: 'GUI 不可用时自动降级到无头 see（默认 true）' },
      full: {
        type: 'boolean',
        description: '整窗口/区域截图：看 Blender UI 时用；默认 false = 3D 视口离屏帧',
      },
      area: { type: 'integer', description: 'full=true 时的区域序号，默认 0' },
      from: {
        type: 'string',
        description:
          '【自定义视角】相机位置 "x,y,z"（世界坐标）；与 look_at 一起给就走自定义视角出图（约 100ms）',
      },
      look_at: { type: 'string', description: '【自定义视角】看向的点 "x,y,z"' },
      lens: { type: 'number', description: '【自定义视角】焦距 mm，默认 50' },
      ortho: { type: 'boolean', description: '【自定义视角】正交投影（配合 ortho_scale）' },
      ortho_scale: {
        type: 'number',
        description: '【自定义视角】正交尺度（贴长边），默认 10',
      },
      view_size: {
        type: 'string',
        description: '【自定义视角】分辨率 "宽x高"，如 "1280x720"；默认按 max_size 出 16:9',
      },
      shading: {
        type: 'string',
        description: '【自定义视角】临时切换着色 WIREFRAME/SOLID/MATERIAL/RENDERED（出图后还原）',
      },
      overlays: {
        type: 'boolean',
        description: '【自定义视角】临时开关覆盖物（网格/坐标轴/gizmo）',
      },
      view_mode: {
        type: 'string',
        description:
          '【自定义视角】viewport（默认，零场景改动）/ render（临时相机 + Workbench 快渲）',
      },
      diagnostics: {
        type: 'boolean',
        description:
          '【自定义视角】强制跑诊断三项（coverage_estimate / scene_bbox / objects_in_frame）；默认不跑省 45–490 ms/次',
      },
      force: {
        type: 'boolean',
        description:
          '上一帧与本帧 hash 完全相同时默认**不重复附图**（省模型侧 token）；传 true 强制重发这张图',
      },
    },
    output: { schema: ANY_SCHEMA, render: renderOne },
    isConcurrencySafe: () => true,
    timeoutMs: instanceTimeout(T.see),
    async execute(args: Record<string, unknown>) {
      return executeSee(args, ctx, port)
    },
  })
}

export function registerSee(ctx: HostContext, port: number): void {
  ctx.effect(() => ctx.tools.register(buildSeeTool(ctx, port)), 'dsh-blender-plugin: rt-see')
}
