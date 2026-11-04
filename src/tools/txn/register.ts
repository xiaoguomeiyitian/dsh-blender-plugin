import { vTool } from '../../contracts/tool.js'
import { ANY_SCHEMA } from '../schema-diagnostic.js'
import { T } from '../../constants.js'
import { renderOne } from '../../ui/cards.js'
import type { HostContext } from '../../host/context.js'
import { executeTxn } from './execute.js'
import { instanceTimeout } from '../../host/instance-route.js'

export function registerTxn(ctx: HostContext, port: number): void {
  ctx.effect(
    () =>
      ctx.tools.register(
        vTool({
          name: 'blender_rt_txn',
          description:
            '【事务 / 回滚】两级快照：**文件级** snapshot/restore（整场景回退；写 .blend 副本不改 filepath；有 MB 级成本）+ **对象级** mark/revert（只记 transform / 材质槽 / 可见性 / 修改器开关，毫秒级、就地回滚）。' +
            '用途："整个场景推倒重来之前先留个点"（snapshot）、"只改一处再对比"（mark 再 revert）。' +
            'restore 默认 into="auto"：把会话放回**快照的出处文件**，载入前自动留 pre_restore 备份。' +
            '⚠️ 边界：对象级**不含拓扑/UV/顶点级改动** —— Boolean、合并、删面之后回不去（revert 会跳过并报告），那种回滚请用文件级 snapshot/restore。',
          parameters: {
            instance: { type: 'string', description: '实例 ID（默认本会话独占）' },
            op: {
              type: 'string',
              required: true,
              description:
                'snapshot | restore | list | prune | mark | revert | marks | drop | help',
            },
            label: { type: 'string', description: '快照 / mark 的名字（snapshot 省略则用时间戳）' },
            objects: { type: 'string', description: 'mark 时限定对象（逗号分隔；省略 = 全场景）' },
            keep: { type: 'integer', description: 'prune 只保留最近 N 个快照，默认 5' },
            note: { type: 'string', description: 'snapshot 备注' },
            into: {
              type: 'string',
              description:
                'restore 回写口径：auto（默认，回到快照的出处文件）| snapshot（非破坏，不写原文件）| original（必须能回写，否则失败）',
            },
            backup: {
              type: 'boolean',
              description: 'restore 前是否自动留 pre_restore 备份（默认 true）',
            },
          },
          output: { schema: ANY_SCHEMA, render: renderOne },
          isConcurrencySafe: () => false,
          timeoutMs: instanceTimeout(T.txn),
          async execute(args: Record<string, unknown>) {
            return executeTxn(port, args)
          },
        }),
      ),
    'dsh-blender-plugin: rt-txn',
  )
}
