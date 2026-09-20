// 作业机那一层的验收：一个 outDir 一次只落一个作业、已有产物的显式策略、围栏在真链路上生效、
// 以及落了 failed 之后凭盘上归档 recover（零云端、零额度）。云端是替身，PDF 是随手写的假文件。
// 跑：pnpm test（先 build 再 node --test tests/）。
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { fakeCloud, treeOf, zipOf } from './helpers.mjs'

const MODULE = pathToFileURL(path.join(import.meta.dirname, '..', 'dist', 'index.js')).href
const { default: GwbMineru } = await import(MODULE)

const ROOT = await mkdtemp(path.join(os.tmpdir(), 'gwb-mineru-jobs-'))
after(() => rm(ROOT, { recursive: true, force: true }))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const exists = async (target) => (await stat(target).catch(() => undefined)) !== undefined

/** 一个够用的 home：真 cordis Context + 三个假邻居服务（settings / data / commands）+ 假内核 */
function makeHome() {
  const ctx = new Context()
  for (const name of ['gwbSettings', 'gwbData', 'gwbCommands', 'gwbKernel']) ctx.provide(name)
  const docs = new Map()
  const events = []
  ctx.set('gwbSettings', { define: () => () => {}, get: (key) => (key === 'token' ? 'test-token' : undefined) })
  ctx.set('gwbData', {
    readDoc: async (name) => docs.get(name),
    writeDoc: async (name, doc) => {
      docs.set(name, doc)
    },
  })
  ctx.set('gwbCommands', { register: () => () => {} })
  ctx.set('gwbKernel', {
    dataDir: ROOT,
    version: 'test',
    emit: (payload) => events.push(payload),
    setShell: () => () => {},
  })
  const service = new GwbMineru(ctx)
  return { service, events, docs }
}

async function scratch(name) {
  const dir = path.join(ROOT, name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  return dir
}

/** 假 PDF：统一摆进 <dir>/in/，跟 outDir 分开——树列举才不会把输入当产物 */
async function fakePdf(dir, name = 'paper.pdf') {
  const file = path.join(dir, 'in', name)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, Buffer.from('%PDF-1.4 假文件\n'))
  return file
}

async function settled(service, id, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = service.get(id)
    if (job !== undefined && ['done', 'failed', 'interrupted'].includes(job.state)) return job
    if (Date.now() > deadline) throw new Error(`作业没落定：${id}（此刻 ${String(job?.state)}）`)
    await sleep(10)
  }
}

const failed = async (promise) => {
  const err = await promise.then(
    () => undefined,
    (one) => one,
  )
  assert.ok(err instanceof Error, '这一步该拒，却没拒')
  return err
}

const GOOD_ZIP = zipOf([
  ['full.md', '# 正文\n中文正文\n'],
  ['images/a.png', 'A'],
  ['layout.json', '{}'],
])

describe('一条作业的全链（云端替身）', () => {
  it('done 的账里有 commit / archive / files / skipped，产物整份在 outDir', async () => {
    const dir = await scratch('happy')
    const outDir = path.join(dir, 'out')
    const cloud = fakeCloud({ zip: GOOD_ZIP })
    const { service } = makeHome()
    const [job] = await service.submit([{ input: await fakePdf(dir), outDir }])
    assert.equal(job.state, 'queued', 'submit 秒回的是作业号（还在跑）')
    const done = await settled(service, job.id)
    assert.equal(done.state, 'done')
    assert.equal(done.commit, 'created')
    assert.equal(done.markdown, 'full.md')
    assert.equal(done.lang, 'zh')
    assert.deepEqual([...done.files], ['full.md', 'images/a.png'])
    assert.deepEqual([...done.skipped], ['layout.json'])
    assert.equal(await exists(done.archive), true, '原始 zip 要在盘上留一份')
    assert.deepEqual(await treeOf(outDir), ['full.md', 'images/a.png'])
    assert.equal(cloud.batchRequests(), 1, '一条作业一次报名')
  })

  it('归档里的越界条目让作业 failed，且 outDir 外面不落东西', async () => {
    const dir = await scratch('fenced')
    const outDir = path.join(dir, 'out')
    fakeCloud({ zip: zipOf([['full.md', '# 正文\n'], ['images/../../zip-escaped.txt', '恶意']]) })
    const { service } = makeHome()
    const [job] = await service.submit([{ input: await fakePdf(dir), outDir }])
    const done = await settled(service, job.id)
    assert.equal(done.state, 'failed')
    assert.match(String(done.error), /images\/\.\.\/\.\.\/zip-escaped\.txt/, 'error 里要指名那条 entry')
    assert.match(String(done.error), /\.\. 段/, 'error 里要说清犯的哪条')
    assert.equal(await exists(outDir), false, 'outDir 不该被建出来')
    assert.deepEqual(await treeOf(dir), ['.out.pdf2md/archive-' + job.id + '.zip', 'in/paper.pdf'], '只留归档，不许留 staged 残骸')
    assert.equal(await exists(done.archive), true, '拒了也要留归档（凭它看清账）')
  })
})

describe('一个 outDir 一次只落一个作业', () => {
  it('同批两条瞄着同一个 outDir：整批当场拒，账上零条、云端零调用', async () => {
    const dir = await scratch('same-batch')
    const outDir = path.join(dir, 'out')
    const cloud = fakeCloud({ zip: GOOD_ZIP })
    const { service } = makeHome()
    const pdf = await fakePdf(dir)
    const err = await failed(service.submit([{ input: pdf, outDir }, { input: pdf, outDir }]))
    assert.match(err.message, /同一个 outDir/)
    assert.equal(service.list().length, 0, '不落半批账')
    assert.equal(cloud.calls.length, 0, '云端一次都不该问')
    assert.equal(await exists(outDir), false)
  })

  it('前一条还在跑，后一条瞄同一个 outDir：拒，并点名是谁占着', async () => {
    const dir = await scratch('busy')
    const outDir = path.join(dir, 'out')
    const cloud = fakeCloud({ zip: GOOD_ZIP })
    const release = cloud.gate.arm() // 轮询那一问先卡住，作业停在 running
    const { service } = makeHome()
    const pdf = await fakePdf(dir)
    const [first] = await service.submit([{ input: pdf, outDir }])
    for (let i = 0; i < 200 && !cloud.calls.some((one) => one.includes('/extract-results/batch/')); i += 1) await sleep(10)
    assert.equal(service.get(first.id)?.state, 'running')

    const err = await failed(service.submit([{ input: pdf, outDir }]))
    assert.match(err.message, /正被作业/)
    assert.match(err.message, new RegExp(first.id))
    assert.equal(service.list().length, 1, '第二条不落账')

    release()
    assert.equal((await settled(service, first.id)).state, 'done')
    // 落定之后同 outDir 可以再交——但那一关归「已有产物」管（见下一组）
  })

  it('前一条 done 之后，同 outDir 没带 overwrite：拒（差在已有产物，不在占用）', async () => {
    const dir = await scratch('after-done')
    const outDir = path.join(dir, 'out')
    fakeCloud({ zip: GOOD_ZIP })
    const { service } = makeHome()
    const pdf = await fakePdf(dir)
    const [first] = await service.submit([{ input: pdf, outDir }])
    await settled(service, first.id)
    const err = await failed(service.submit([{ input: pdf, outDir }]))
    assert.match(err.message, /已经有/)
    assert.deepEqual(await treeOf(outDir), ['full.md', 'images/a.png'], '旧产物没被动')
  })
})

describe('覆盖已有产物要显式说', () => {
  it('带 overwrite：旧产物整份进备份，新产物落位，账上写 replaced', async () => {
    const dir = await scratch('overwrite')
    const outDir = path.join(dir, 'out')
    await mkdir(outDir, { recursive: true })
    await writeFile(path.join(outDir, 'full.md'), '# 上一版\n')
    await writeFile(path.join(outDir, '旧文件.txt'), '上一版的东西')
    fakeCloud({ zip: GOOD_ZIP })
    const { service } = makeHome()
    const [job] = await service.submit([{ input: await fakePdf(dir), outDir, overwrite: true }])
    const done = await settled(service, job.id)
    assert.equal(done.state, 'done')
    assert.equal(done.commit, 'replaced')
    assert.equal(done.overwrite, true)
    assert.ok(done.backup !== undefined, '账上要有备份目录')
    assert.deepEqual(await treeOf(done.backup), ['full.md', '旧文件.txt'], '备份里是完整的上一版')
    assert.deepEqual(await treeOf(outDir), ['full.md', 'images/a.png'], 'outDir 里只有新版')
    assert.equal(await readFile(path.join(outDir, 'full.md'), 'utf8'), '# 正文\n中文正文\n')
  })
})

describe('提交点撞车与 recover：不必再花云端额度', () => {
  it('云端跑的这几分钟里 outDir 被塞了东西：提交点拒 → failed 且账上有归档 → 清场后 recover 补上', async () => {
    const dir = await scratch('recover')
    const outDir = path.join(dir, 'out')
    const cloud = fakeCloud({ zip: GOOD_ZIP })
    const release = cloud.gate.arm()
    const { service } = makeHome()
    const [job] = await service.submit([{ input: await fakePdf(dir), outDir }])
    for (let i = 0; i < 200 && !cloud.calls.some((one) => one.includes('/extract-results/batch/')); i += 1) await sleep(10)
    await mkdir(outDir, { recursive: true })
    await writeFile(path.join(outDir, '别人放的.txt'), '抢位') // 云端还在跑的这段时间有人动了 outDir
    release()

    const done = await settled(service, job.id)
    assert.equal(done.state, 'failed')
    assert.match(String(done.error), /outDir 没动/)
    assert.equal(await exists(done.archive), true, '归档要在（云端那份结果已经在盘上了）')
    assert.deepEqual(await treeOf(outDir), ['别人放的.txt'], '被占的 outDir 一个字节都没动')
    const cloudCallsAfterFailure = cloud.calls.length

    await rm(path.join(outDir, '别人放的.txt'))
    const recovered = await service.recover(job.id)
    assert.equal(recovered.state, 'done')
    assert.equal(recovered.commit, 'created')
    assert.deepEqual([...recovered.files], ['full.md', 'images/a.png'])
    assert.deepEqual(await treeOf(outDir), ['full.md', 'images/a.png'])
    assert.equal(cloud.calls.length, cloudCallsAfterFailure, 'recover 一次云端都不碰')
    assert.equal(cloud.batchRequests(), 1, '没有第二次报名')
  })

  it('recover 的守卫：done 的、在跑的、账上没有归档的，都拒', async () => {
    const dir = await scratch('guards')
    const cloud = fakeCloud({ zip: GOOD_ZIP })
    const { service } = makeHome()
    const pdf = await fakePdf(dir)

    const doneDir = path.join(dir, 'done-out')
    const [finished] = await service.submit([{ input: pdf, outDir: doneDir }])
    await settled(service, finished.id)
    assert.match((await failed(service.recover(finished.id))).message, /已经是 done/)

    const busyDir = path.join(dir, 'busy-out')
    cloud.gate.arm()
    const [busy] = await service.submit([{ input: pdf, outDir: busyDir }])
    for (let i = 0; i < 200 && !cloud.calls.some((one) => one.includes('/extract-results/batch/')); i += 1) await sleep(10)
    assert.match((await failed(service.recover(busy.id))).message, /还在跑/)
    cloud.gate.release()
    await settled(service, busy.id)

    assert.match((await failed(service.recover('没这个号'))).message, /没有这个作业/)
  })

  it('云端解析失败（没下载过 zip）的作业：recover 说清没有归档，重提才有结果', async () => {
    const dir = await scratch('no-archive')
    const outDir = path.join(dir, 'out')
    fakeCloud({ zip: GOOD_ZIP, outcome: 'failed' })
    const { service } = makeHome()
    const [job] = await service.submit([{ input: await fakePdf(dir), outDir }])
    const done = await settled(service, job.id)
    assert.equal(done.state, 'failed')
    assert.equal(done.error, '解析失败（替身）')
    assert.equal(done.archive, undefined, '没走到下载就没有归档')
    assert.match((await failed(service.recover(job.id))).message, /没有归档/)
  })
})
