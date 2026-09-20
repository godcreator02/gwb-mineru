// 问：解包链那两条缺陷在真代码上长什么样，修完还剩什么——
//   1) 围栏（GWB-30）：归档里一条 images/../../zip-escaped.txt 能不能写到 outDir 外面
//   2) 同 outDir 两条作业（GWB-31）：并行解包会不会互相盖，先 done 的那条账还准不准
//   3) outDir 已有产物时：是静默盖掉，还是显式拒
// 跑：node probe.mjs                —— 打仓根 dist 那份（改前先 `pnpm build` 跑一次留基线，改后再跑一次）
//     node probe.mjs <模块路径>     —— 换一份 dist/core/extract.js（对照用）
// 零网络零额度：fetch 被替身接管，zip 是 adm-zip 现搓的；adm-zip 走仓根 node_modules，与件同版本。
// 落点是系统临时区（probes/ 只留输出记录，不留产物）。
import AdmZip from 'adm-zip'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MODULE = process.argv[2] ?? path.join(import.meta.dirname, '..', '..', 'dist', 'core', 'extract.js')
const SCRATCH = path.join(os.tmpdir(), 'mineru-fence-probe')

/** 现搓一个 zip：entries 是 [名字, 内容]。
 * 名字要**照原样**进包里——adm-zip 的 addFile 会把 `..` 归一掉（实测 `images/../../x` → `x`），
 * 所以先按平价名加、再把 entryName 改回去；远端那份被人做过手脚的归档就是这么来的。 */
function zipOf(entries) {
  const bundle = new AdmZip()
  entries.forEach(([name, body]) => bundle.addFile(name, Buffer.from(body, 'utf8')))
  bundle.getEntries().forEach((entry, index) => {
    entry.entryName = entries[index][0]
  })
  return bundle.toBuffer()
}

/** fetch 替身：URL → zip 字节 */
const served = new Map()
globalThis.fetch = async (url) => {
  const body = served.get(String(url))
  return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 })
}

/** 递归列一棵树，相对给定根，POSIX 斜杠 */
async function treeOf(root) {
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

const say = (line) => console.log(line)
const shape = (err) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

await rm(SCRATCH, { recursive: true, force: true })
await mkdir(SCRATCH, { recursive: true })
const { downloadExtract } = await import(pathToFileURL(MODULE).href)

say(`# 解包围栏 / 同 outDir 并发 —— 探针`)
say(`模块：${MODULE}`)
say('')

// ── 1 越界写：正斜杠与反斜杠两种写法 ──────────────────────────────────────────
say('## 1 越界写（GWB-30）：归档里塞 ../ 与反斜杠变体')
for (const [tag, escapeName] of [
  ['正斜杠', 'images/../../zip-escaped.txt'],
  ['反斜杠', 'images/..\\..\\zip-escaped2.txt'],
]) {
  const outDir = path.join(SCRATCH, 'escape', tag, 'out')
  await mkdir(outDir, { recursive: true })
  served.set('https://fake/escape.zip', zipOf([
    ['full.md', '# 标题\n'],
    ['images/ok.png', 'PNG'],
    [escapeName, '被写到 outDir 外面了'],
  ]))
  let verdict
  try {
    const result = await downloadExtract('https://fake/escape.zip', outDir, { jobId: `probe-${tag === '正斜杠' ? 'slash' : 'backslash'}` })
    verdict = `没拒——交出 files=[${result.files.join(', ')}]`
  } catch (err) {
    verdict = `拒了——${shape(err)}${err.entry !== undefined ? `（entry=${JSON.stringify(err.entry)} reason=${String(err.reason)}）` : ''}`
  }
  const landed = await treeOf(path.join(SCRATCH, 'escape', tag))
  // 工作根（`.out.pdf2md/`）是解包自己的暂存区，按设计就在 outDir 旁边——越界说的是它之外还有东西
  const outside = landed.filter((one) => !one.startsWith('out/') && !one.startsWith('.out.pdf2md/'))
  const work = landed.filter((one) => one.startsWith('.out.pdf2md/'))
  say(`- ${tag} ${JSON.stringify(escapeName)}`)
  say(`  ${verdict}`)
  say(`  落盘：${landed.length === 0 ? '（空）' : landed.join('、')}`)
  say(`  工作根里的东西（按设计）：${work.length === 0 ? '无' : work.join('、')}`)
  say(`  outDir 与工作根之外的文件：${outside.length === 0 ? '无' : outside.join('、')}${outside.length > 0 ? '  ← 越界了' : ''}`)
}
say('')

// ── 2 同 outDir 两条作业并行 ─────────────────────────────────────────────────
say('## 2 同 outDir 两条作业并行（GWB-31）：谁盖谁')
{
  const outDir = path.join(SCRATCH, 'share', 'out')
  await mkdir(outDir, { recursive: true })
  const body = (tag) => zipOf([
    ['full.md', `# ${tag}\n`],
    [`images/${tag}.png`, `${tag} 的图`],
  ])
  served.set('https://fake/a.zip', body('jia'))
  served.set('https://fake/b.zip', body('yi'))
  const settled = await Promise.allSettled([
    downloadExtract('https://fake/a.zip', outDir, { jobId: 'jia' }),
    downloadExtract('https://fake/b.zip', outDir, { jobId: 'yi' }),
  ])
  settled.forEach((one, index) => {
    const tag = ['甲', '乙'][index]
    say(`- ${tag}作业：${one.status === 'fulfilled' ? `done，账上 files=[${one.value.files.join(', ')}] commit=${String(one.value.commit)}` : `拒了——${shape(one.reason)}`}`)
  })
  const landed = await treeOf(outDir)
  say(`  最终 outDir：${landed.join('、')}`)
  const md = await readFile(path.join(outDir, 'full.md'), 'utf8').catch(() => '（读不到）')
  say(`  最终 full.md 是谁的：${md.trim()}`)
  const winners = settled.map((one, index) => (one.status === 'fulfilled' ? index : -1)).filter((one) => one >= 0)
  if (winners.length === 0) {
    say('  两条都没落成（都拒了）')
  } else if (winners.length > 1) {
    say('  两条都声称落成了：outDir 只能有一份产物，必有人的账已经不准')
  } else {
    const won = settled[winners[0]]
    const tag = ['甲', '乙'][winners[0]]
    const match =
      won.value.files.length === landed.length && won.value.files.every((one) => landed.includes(one))
    say(`  赢家是${tag}作业（另一条被拒）：最终产物与它的账${match ? '对得上' : '对不上'}`)
  }
}
say('')

// ── 3 outDir 已有产物：静默盖掉还是显式拒 ────────────────────────────────────
say('## 3 outDir 已有产物：默认策略')
for (const overwrite of [undefined, true]) {
  const tag = overwrite === true ? 'overwrite:true' : '默认'
  const outDir = path.join(SCRATCH, 'replace', overwrite === true ? 'yes' : 'default')
  await mkdir(path.join(outDir, 'images'), { recursive: true })
  await writeFile(path.join(outDir, 'full.md'), '# 上一版\n')
  await writeFile(path.join(outDir, 'images', 'old.png'), '上一版的图')
  served.set('https://fake/new.zip', zipOf([['full.md', '# 新一版\n'], ['images/new.png', '新的图']]))
  let verdict
  try {
    const result = await downloadExtract('https://fake/new.zip', outDir, { jobId: `probe-replace-${tag}`, overwrite })
    verdict = `落了：commit=${String(result.commit)} backup=${String(result.backup)} files=[${result.files.join(', ')}]`
  } catch (err) {
    verdict = `拒了——${shape(err)}`
  }
  const landed = await treeOf(outDir)
  say(`- ${tag}`)
  say(`  ${verdict}`)
  say(`  最终 outDir：${landed.join('、')}`)
}
say('')
say('（完）')
