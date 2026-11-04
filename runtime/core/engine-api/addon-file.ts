// fork delta ②（跨容器部署）：读回 addon 侧产出的文件（PNG）。
//
// frame/frameArea/view 的默认路径面向"同机"拓扑（WSL/Windows）：addon 把图写进
// 共享工作目录，宿主直接 fs 读。跨容器部署时两侧文件系统不同，本地读必然
// ENOENT——这里退一步：用 execute_code 让 addon 把同一文件读出来，base64 经
// socket 回传。同机拓扑行为不变（本地读到就直接返回，不走 socket）。
import fs from 'node:fs'
import type { AddonClient } from '../../transport/probes.js'
import { winToWsl } from '../../config.js'
import { extractTag } from '../output/index.js'

export interface AddonFileDeps {
  addon: AddonClient
}

export function createAddonFileReader(E: AddonFileDeps) {
  const { addon } = E
  /**
   * @param addonPath addon 侧（Windows 容器内）看到的文件路径
   * @returns 文件字节
   */
  async function readAddonFile(addonPath: string): Promise<Buffer> {
    try {
      return fs.readFileSync(winToWsl(addonPath))
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code
      if (code !== 'ENOENT') throw e
    }
    const code =
      'import base64, json\n' +
      'print("DSHPNG " + json.dumps(base64.b64encode(open(' +
      JSON.stringify(addonPath) +
      ', "rb").read()).decode()))\n'
    let b64: string
    try {
      b64 = String(extractTag(await addon.send('execute_code', { code }, 120000), 'DSHPNG') ?? '')
    } catch (e) {
      throw new Error(
        '跨容器读回失败（addon 侧无此文件或回传为空）: ' +
          String(addonPath) +
          ' | ' +
          String((e && (e as Error).message) || e).slice(0, 200),
        { cause: e },
      )
    }
    return Buffer.from(b64, 'base64')
  }
  return { readAddonFile }
}
