// 解包那一层的验收：围栏（每一条都得有名有姓地拒）+ staging 全量校验后才落盘 + 原子提交 + 归档可重解。
// 跑：pnpm test（先 build 再 vitest run）。零网络：fetch 换成替身，zip 是手搓的。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, it } from 'vitest'
import { treeOf, zipOf } from './helpers.mjs'

const MODULE = pathToFileURL(path.join(import.meta.dirname, '..', 'dist', 'core', 'extract.js')).href
const { CommitRejectedError, EntryRejectedError, downloadExtract, extractArchive, isChineseDominant } = await import(MODULE)

const ROOT = await mkdtemp(path.join(os.tmpdir(), 'gwb-mineru-extract-'))
afterAll(() => rm(ROOT, { recursive: true, force: true }))

const caseDir = async (name) => {
  const dir = path.join(ROOT, name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  return dir
}
const exists = async (target) => (await stat(target).catch(() => undefined)) !== undefined

/** 假的云端下载：只认一个地址，回给定 zip */
function serve(zip) {
  globalThis.fetch = async (url) =>
    String(url) === 'https://fake/result.zip' ? new Response(zip, { status: 200 }) : new Response('no', { status: 404 })
}

async function rejects(promise, reason) {
  try {
    await promise
  } catch (err) {
    assert.ok(err instanceof EntryRejectedError, `要 EntryRejectedError，实际是 ${String(err)}`)
    assert.equal(err.reason, reason)
    return err
  }
  throw new Error(`没拒（期望 reason=${reason}）`)
}

describe('围栏：一条不合格就整包不落盘', () => {
  const cases = [
    ['../ 段', 'images/../../zip-escaped.txt', 'dotdot'],
    ['反斜杠', 'images/..\\..\\zip-escaped2.txt', 'backslash'],
    ['盘符', 'C:/zip-escaped3.txt', 'colon'],
    ['绝对路径', '/zip-escaped4.txt', 'absolute'],
    ['NTFS 备用数据流', 'images/ok.png:evil', 'colon'],
    ['控制字符', 'images/ok\u0000.png', 'control'],
    ['归一后一个路径段都不剩', '.', 'empty'],
  ]
  for (const [label, name, reason] of cases) {
    it(`${label}（${JSON.stringify(name)}）被拒，且 outDir 与外面都不落东西`, async () => {
      const dir = await caseDir(`fence-${reason}-${label}`)
      const outDir = path.join(dir, 'out')
      serve(zipOf([['full.md', '# 正文\n'], [name, '恶意内容']]))
      const err = await rejects(downloadExtract('https://fake/result.zip', outDir, { jobId: 'fence' }), reason)
      assert.equal(err.entry, name, '错误里要指名是哪条 entry')
      assert.ok(err.message.includes(JSON.stringify(name)), '错误正文要带 entry 名字')
      assert.equal(await exists(outDir), false, 'outDir 不该被建出来')
      assert.deepEqual(await treeOf(dir), ['.out.pdf2md/archive-fence.zip'], '只留归档，别的什么都不许落')
    })
  }

  it('一条坏的不许把前面的好条目带进去：整包零落盘', async () => {
    const dir = await caseDir('fence-all-or-nothing')
    const outDir = path.join(dir, 'out')
    serve(
      zipOf([
        ['full.md', '# 正文\n'],
        ['images/a.png', 'A'],
        ['images/b.png', 'B'],
        ['images/../../zip-escaped.txt', '恶意内容'],
      ]),
    )
    await rejects(downloadExtract('https://fake/result.zip', outDir, { jobId: 'fence' }), 'dotdot')
    assert.equal(await exists(outDir), false, '校验没过就不许有半个 outDir')
    assert.deepEqual(await treeOf(dir), ['.out.pdf2md/archive-fence.zip'], '只许留下归档，不许留 staged 残骸')
  })

  it('两条 entry 归一后同一个落点：拒', async () => {
    const dir = await caseDir('fence-duplicate')
    serve(zipOf([['full.md', '# 正文\n'], ['images/a.png', 'A'], ['images/a.png', 'B']]))
    const err = await rejects(downloadExtract('https://fake/result.zip', path.join(dir, 'out'), { jobId: 'dup' }), 'duplicate')
    assert.equal(err.entry, 'images/a.png')
  })
})

describe('白名单与产出', () => {
  it('只搬根下 markdown 与 images/ 子树；杂项列进 skipped，不静默丢', async () => {
    const dir = await caseDir('happy')
    const outDir = path.join(dir, 'out')
    serve(
      zipOf([
        ['full.md', '# 中文标题\n中文正文\n'],
        ['images/a.png', 'A'],
        ['layout.json', '{}'],
        ['paper_content_list.json', '[]'],
      ]),
    )
    const result = await downloadExtract('https://fake/result.zip', outDir, { jobId: 'happy' })
    assert.equal(result.markdown, 'full.md')
    assert.equal(result.lang, 'zh')
    assert.equal(result.commit, 'created')
    assert.deepEqual([...result.files], ['full.md', 'images/a.png'])
    assert.deepEqual([...result.skipped], ['layout.json', 'paper_content_list.json'])
    assert.deepEqual(await treeOf(outDir), ['full.md', 'images/a.png'])
    assert.equal(await exists(result.archive), true, '归档要落盘')
    assert.deepEqual(await readFile(path.join(outDir, 'full.md'), 'utf8'), '# 中文标题\n中文正文\n')
  })

  it('markdown 不在 zip 根下：拒（不猜、不静默）', async () => {
    const dir = await caseDir('nested-markdown')
    serve(zipOf([['result/full.md', '# 正文\n']]))
    const err = await downloadExtract('https://fake/result.zip', path.join(dir, 'out'), { jobId: 'nested' }).catch((one) => one)
    assert.ok(err instanceof Error && err.message.includes('markdown 不在 zip 根下'), String(err))
  })

  it('中文占比判 zh、英文占比判 en（老口径不变）', () => {
    assert.equal(isChineseDominant('这是一篇论文的正文'), true)
    assert.equal(isChineseDominant('this is a paper body'), false)
  })
})

describe('提交点：已有产物默认拒、显式 overwrite 才覆盖', () => {
  const seed = async (outDir) => {
    await mkdir(path.join(outDir, 'images'), { recursive: true })
    await writeFile(path.join(outDir, 'full.md'), '# 上一版\n')
    await writeFile(path.join(outDir, 'images', 'old.png'), '旧图')
  }

  it('没带 overwrite：拒，outDir 一个字节没动', async () => {
    const dir = await caseDir('commit-default')
    const outDir = path.join(dir, 'out')
    await seed(outDir)
    serve(zipOf([['full.md', '# 新一版\n'], ['images/new.png', '新图']]))
    const err = await downloadExtract('https://fake/result.zip', outDir, { jobId: 'replace' }).catch((one) => one)
    assert.ok(err instanceof CommitRejectedError, String(err))
    assert.equal(err.outDir, outDir)
    assert.deepEqual(await treeOf(outDir), ['full.md', 'images/old.png'], '旧产物原样')
    assert.equal(await readFile(path.join(outDir, 'full.md'), 'utf8'), '# 上一版\n')
  })

  it('带 overwrite：旧产物整体进备份、新版整份落位', async () => {
    const dir = await caseDir('commit-overwrite')
    const outDir = path.join(dir, 'out')
    await seed(outDir)
    serve(zipOf([['full.md', '# 新一版\n'], ['images/new.png', '新图']]))
    const result = await downloadExtract('https://fake/result.zip', outDir, { jobId: 'replace', overwrite: true })
    assert.equal(result.commit, 'replaced')
    assert.ok(result.backup !== undefined && (await exists(result.backup)))
    assert.deepEqual(await treeOf(result.backup), ['full.md', 'images/old.png'], '备份里是完整上一版')
    assert.deepEqual(await treeOf(outDir), ['full.md', 'images/new.png'], 'outDir 里只有新版，不混')
  })

  it('outDir 是个文件：拒', async () => {
    const dir = await caseDir('commit-file')
    const outDir = path.join(dir, 'out')
    await writeFile(outDir, '我是个文件')
    serve(zipOf([['full.md', '# 正文\n']]))
    const err = await downloadExtract('https://fake/result.zip', outDir, { jobId: 'file' }).catch((one) => one)
    assert.ok(err instanceof CommitRejectedError, String(err))
  })
})

describe('并发：同 outDir 两条作业，一条落成、一条显式拒', () => {
  it('两条并排解同一个 outDir：不许静默互盖', async () => {
    const dir = await caseDir('race')
    const outDir = path.join(dir, 'out')
    await mkdir(outDir, { recursive: true })
    const zips = {
      'https://fake/a.zip': zipOf([['full.md', '# 甲\n'], ['images/jia.png', '甲']]),
      'https://fake/b.zip': zipOf([['full.md', '# 乙\n'], ['images/yi.png', '乙']]),
    }
    globalThis.fetch = async (url) => new Response(zips[String(url)] ?? 'no', { status: zips[String(url)] === undefined ? 404 : 200 })
    const settled = await Promise.allSettled([
      downloadExtract('https://fake/a.zip', outDir, { jobId: 'jia' }),
      downloadExtract('https://fake/b.zip', outDir, { jobId: 'yi' }),
    ])
    const won = settled.filter((one) => one.status === 'fulfilled')
    const lost = settled.filter((one) => one.status === 'rejected')
    assert.equal(won.length, 1, '同 outDir 只能有一条落成')
    assert.equal(lost.length, 1, '另一条要显式拒')
    assert.ok(lost[0].reason instanceof CommitRejectedError, String(lost[0].reason))
    const landed = await treeOf(outDir)
    assert.deepEqual(landed.sort(), [...won[0].value.files].sort(), '最终产物就是赢家的账，不多不少')
  })
})

describe('归档：解包失败/中断后凭它重新解包，不必再问云端', () => {
  it('归档落盘后，零网络再解一遍能补齐产物', async () => {
    const dir = await caseDir('recover')
    const outDir = path.join(dir, 'out')
    serve(zipOf([['full.md', '# 正文\n'], ['images/a.png', 'A']]))
    const first = await downloadExtract('https://fake/result.zip', outDir, { jobId: 'first' })
    assert.deepEqual([...first.files], ['full.md', 'images/a.png'])

    await rm(outDir, { recursive: true, force: true })
    globalThis.fetch = async () => {
      throw new Error('重新解包不许碰网络')
    }
    const again = await extractArchive(first.archive, outDir, { jobId: 'again' })
    assert.equal(again.commit, 'created')
    assert.deepEqual([...again.files], ['full.md', 'images/a.png'])
    assert.equal(await readFile(path.join(outDir, 'full.md'), 'utf8'), '# 正文\n')
  })

  it('围栏拒了也留着归档：错在归档本身，重解一次还是同样的拒', async () => {
    const dir = await caseDir('recover-after-fence')
    const outDir = path.join(dir, 'out')
    serve(zipOf([['full.md', '# 正文\n'], ['images/../escaped.txt', '恶意']]))
    const err = await downloadExtract('https://fake/result.zip', outDir, { jobId: 'fenced' }).catch((one) => one)
    assert.ok(err instanceof EntryRejectedError, String(err))
    assert.equal(await exists(err.archive), true, '拒也要留下归档，凭它才能看清账')
    const again = await extractArchive(err.archive, outDir, { jobId: 'fenced' }).catch((one) => one)
    assert.ok(again instanceof EntryRejectedError, String(again))
    assert.equal(again.reason, 'dotdot')
  })
})
