// 两条测试共用的假料：手搓 zip（名字照原样进包——adm-zip 的 addFile 会把 .. 归一掉）、
// 目录树列举、以及一个替身 fetch（云端那三个动作 + 下载结果 zip，全在内存里，零网络零额度）。
import AdmZip from 'adm-zip'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

/** 现搓一个 zip：entries 是 [名字, 内容]。名字要照原样进包——
 *  adm-zip 的 addFile 会归一（`images/../../x` → `x`）且同名会顶掉前一条，
 *  所以先按序号占位名加、再把 entryName 逐条改回去。 */
export function zipOf(entries) {
  const bundle = new AdmZip()
  entries.forEach(([, body], index) => bundle.addFile(`entry-${String(index)}.bin`, Buffer.from(body)))
  bundle.getEntries().forEach((entry, index) => {
    entry.entryName = entries[index][0]
  })
  return bundle.toBuffer()
}

/** 递归列一棵树，相对给定根，POSIX 斜杠；根不在就回空 */
export async function treeOf(root) {
  const out = []
  const walk = async (dir, rel) => {
    const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const item of items.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel === '' ? item.name : `${rel}/${item.name}`
      if (item.isDirectory()) await walk(path.join(dir, item.name), childRel)
      else out.push(childRel)
    }
  }
  await walk(root, '')
  return out
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

/**
 * 云端替身：报名回 batch_id、PUT 收下、轮询第一问就回终态、下载回那份 zip。
 * `outcome` 是轮询结算：'done' 给结果 zip 地址、'failed' 回云端解析失败（没有 zip 可下）。
 * 返回的 `gate` 是「轮询到这一问时先等着」的闸——测试趁这一刻往盘上摆东西，模拟「云端在跑的
 * 这几分钟里 outDir 被人动了」；`release()` 放行。`calls` 记全部请求，用来断言「recover 没碰云端」。
 */
export function fakeCloud({ zip, outcome = 'done' }) {
  const calls = []
  const state = { gate: null }
  const gate = {
    arm() {
      let release
      const promise = new Promise((resolve) => {
        release = resolve
      })
      state.gate = { promise, release }
      return release
    },
    release() {
      state.gate?.release()
      state.gate = null
    },
  }
  let seq = 0
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    calls.push(`${init.method ?? 'GET'} ${target}`)
    if (target.endsWith('/file-urls/batch')) {
      seq += 1
      return json({ code: 0, data: { batch_id: `batch-${String(seq)}`, file_urls: [`https://fake/put/${String(seq)}`] } })
    }
    if (target.startsWith('https://fake/put/')) return new Response('ok', { status: 200 })
    if (target.includes('/extract-results/batch/')) {
      if (state.gate !== null) await state.gate.promise
      if (outcome === 'failed') {
        return json({
          code: 0,
          data: {
            extract_result: [
              { file_name: 'x.pdf', state: 'failed', full_zip_url: null, err_msg: '解析失败（替身）', extract_progress: null },
            ],
          },
        })
      }
      return json({
        code: 0,
        data: {
          extract_result: [
            { file_name: 'x.pdf', state: 'done', full_zip_url: 'https://fake/result.zip', err_msg: null, extract_progress: null },
          ],
        },
      })
    }
    if (target === 'https://fake/result.zip') return new Response(zip, { status: 200 })
    return new Response('not found', { status: 404 })
  }
  return { calls, gate, batchRequests: () => calls.filter((one) => one.includes('/file-urls/batch')).length }
}
