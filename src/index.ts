import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { Service } from 'cordis'
import { isRecord, requireKernel, type GwbContext } from '@godcreator/gwb-plugin-api'
// 只为激活 commands / data / skills / settings 四个件给 cordis Context 加的服务名。
// type-only，运行期不欠它们；static inject 那三个名字靠这些声明才有类型
import type {} from '@godcreator/gwb-commands'
import type {} from '@godcreator/gwb-data'
import type {} from '@godcreator/gwb-settings'
import type {} from '@godcreator/gwb-skills'
import { ArchiveError, downloadExtract, extractArchive, type ExtractResult } from './core/extract.js'
import { MAX_FILE_BYTES, isDone, poll, requestUpload, upload, type FileResult } from './core/mineru.js'

/**
 * pdf2md 服务：MinerU 云端转换的作业机。**submit 秒回、后台跑完落盘**——
 * 命令是页面等着的一次调用，分钟级的云端解析绝不能在线等；作业号先回，终态经
 * `gwbKernel.emit` 推一条事件。
 *
 * **件叫 gwb-mineru、服务叫 gwbPdf2md——名字不对应是有意的**（对着本仓惯例
 * 「服务名跟件名走」的唯一例外）：件名说**谁在干活**（MinerU 引擎），服务名与
 * 命令前缀说**干的是什么**（pdf2md）。消费方 inject 的永远是 `gwbPdf2md`。
 *
 * 零库概念：输入一个 PDF 绝对路径、一个输出目录，产出完整 markdown + images/ 原样落
 * outDir（markdown 文件名、语言判定、文件清单记在作业上）。「归档副本、成品位命名」那套
 * 篇目录布局是调用方（如 papers）的私有约定，不在这儿。
 *
 * **一个 outDir 一次只落一个作业的产物**：提交时就占位，同批撞车、或撞上还在跑的作业，整批当场拒
 * ——两条作业并排往同一个目录里解，先 done 的那条账立刻就不准了。outDir 里已有产物默认拒，
 * 要覆盖得显式 overwrite（旧产物先备份）。围栏与原子提交在解包那一层（见 core/extract.ts）。
 *
 * 三个邻居服务走 `static inject` 硬依赖（gwb-node-cli 的同款姿势）：settings（token）、
 * data（作业账）、commands（命令那面）。缺谁这个件不挂——比挂上之后半身不遂好查。
 * 用的时候一律 `this.own.<服务>` 现取。**设置项必须在 init 里 define**：不声明的话
 * get 永远回 undefined——实机撞过一轮，症状是「token 明明在 settings.json 里，
 * 命令却报没配」。
 */

const PLUGIN_NAME = 'gwb-mineru'
/** 命令登记的 plugin 字段认包名 */
const PACKAGE_NAME = '@godcreator/gwb-mineru'
const JOBS_DOC = 'jobs'

/** 轮询节奏与上限（秒）：5 秒一问；云端干活时进度停滞 10 分钟判失败；连排队在内总上限 1 小时 */
const POLL_INTERVAL_S = 5
const POLL_STALL_S = 600
const POLL_TIMEOUT_S = 3600

export type JobState = 'queued' | 'uploading' | 'running' | 'done' | 'failed' | 'interrupted'

/** 一条作业的账。落盘就是它——只装可序列化的东西 */
export interface Pdf2mdJob {
  readonly id: string
  readonly input: string
  readonly outDir: string
  readonly state: JobState
  readonly createdAt: string
  readonly updatedAt: string
  readonly error?: string
  readonly batchId?: string
  /** 提交时带了覆盖：outDir 里原有的产物已先挪进备份目录（`backup`） */
  readonly overwrite?: boolean
  /** 云端报来的解析进度（running 时才有；done 时补满） */
  readonly progress?: { readonly extractedPages: number; readonly totalPages: number }
  /** 转换成功后交出的三样 */
  readonly markdown?: string
  readonly lang?: 'zh' | 'en'
  readonly files?: readonly string[]
  /** 白名单外、没搬的那些 entry（zip 根上的 layout.json 之类）——列出来，不静默丢 */
  readonly skipped?: readonly string[]
  /** 原始 zip 的落盘副本：重新解包凭它（pdf2md.recover），不必再花一次云端额度 */
  readonly archive?: string
  /** 产物是怎么落进 outDir 的：created 全新；replaced 把上一版挪进 backup 后覆盖 */
  readonly commit?: 'created' | 'replaced'
  /** commit 为 replaced 时，上一版产物挪去的备份目录 */
  readonly backup?: string
}

/** 一次提交里的一条：一个 PDF 进、一个 outDir 出 */
export interface Pdf2mdSubmitInput {
  readonly input: string
  readonly outDir: string
  /**
   * outDir 里已有产物时怎么办。默认拒（整批当场拒，一个字节都不动）；true 才覆盖——
   * 旧产物先整体挪进工作根备份，再提交新版
   */
  readonly overwrite?: boolean
}

/** 消费方拿到的那一格。写 `inject: ['gwbPdf2md']` 才有 */
export interface GwbPdf2mdApi {
  /**
   * 提交一批转换作业（一作业一文件）。验完全部文件与目录、落完账才返回——**返回不是完成**，
   * 成败看 get(id) 的 state。作业各自独立、**同时开跑**（云端各转各的，谁先完谁先落）。
   * 传半个坏形状进来是整批拒，不落半批账；两条作业瞄着同一个 outDir 也整批拒
   * （一个 outDir 一次只落一个作业的产物）
   */
  submit(files: readonly Pdf2mdSubmitInput[]): Promise<Pdf2mdJob[]>
  /**
   * 凭作业盘上那份原始 zip 重新解包进它的 outDir：零云端、零额度。只对 failed / interrupted
   * 且账上有归档的作业有效——解包阶段掉链子时，不必为了同一份结果再花一次云端解析
   */
  recover(id: string): Promise<Pdf2mdJob>
  /** 查一条。没有这个 id 回 undefined */
  get(id: string): Pdf2mdJob | undefined
  /** 此刻账上的全部作业，新的在前 */
  list(): Pdf2mdJob[]
}

/** 设置：一枚凭据。节名跟 cordis.yml 条目 id 走（mineru），声明在 init 里——不声明的话 get 永远回 undefined（实机撞过） */
const TOKEN_DEF = {
  key: 'token',
  title: 'MinerU Token',
  type: 'secret',
  description: 'MinerU 云端转换的 API token，https://mineru.net 申请',
} as const

function nowIso(): string {
  return new Date().toISOString()
}

/** 解包的选项：作业号给工作根分家，覆盖策略照作业账上那条 */
function extractOptions(job: Pdf2mdJob): { jobId: string; overwrite?: boolean } {
  return { jobId: job.id, ...(job.overwrite === true ? { overwrite: true } : {}) }
}

/** 改产物那三样（markdown / lang / files）连同归档与提交结果一起进账 */
function extractReceipt(extracted: ExtractResult): Partial<Pdf2mdJob> {
  return {
    markdown: extracted.markdown,
    lang: extracted.lang,
    files: [...extracted.files],
    skipped: [...extracted.skipped],
    archive: extracted.archive,
    commit: extracted.commit,
    ...(extracted.backup !== undefined ? { backup: extracted.backup } : {}),
  }
}

/** 错误连同 cause 一起说：fetch 失败时真原因（ECONNRESET、连接超时之类）只在 cause 里 */
function describeError(err: unknown): string {
  if (!(err instanceof Error) || err.cause === undefined) return String(err)
  const cause = err.cause
  if (!(cause instanceof Error)) return `${String(err)}（${String(cause)}）`
  const code = (cause as { code?: unknown }).code
  const withCode = typeof code === 'string' && !cause.message.includes(code) ? `${cause.message} ${code}` : cause.message
  return `${String(err)}（${withCode}）`
}

export default class GwbMineru extends Service implements GwbPdf2mdApi {
  /** settings / data / commands 三个硬依赖缺谁不挂 */
  static inject = ['gwbCommands', 'gwbSettings', 'gwbData']

  /**
   * 提供方自己的 ctx。方法里的 `this.ctx` 是**消费者**的——作业的命脉（定时器、
   * 落账、收尾）全挂在提供方身上，消费者卸载不该带走一个还在跑的转换
   */
  private readonly own: GwbContext
  private readonly info: (message: string) => void
  private readonly warn: (message: string) => void
  /** 作业账：id → 记录。落盘经 gwbData */
  private readonly table = new Map<string, Pdf2mdJob>()
  /**
   * outDir（归一后的绝对路径）→ 占着它的作业号。一个 outDir 一次只落一个作业的产物：
   * 两条作业并排往同一个目录里解，谁先完谁的账就立刻不准了（先落的那些文件被后一条盖掉）
   */
  private readonly claims = new Map<string, string>()
  private readonly controllers = new Map<string, AbortController>()
  private jobSeq = 0
  /** 作业账写盘一个接一个：同一个文件并发 rename，Windows 上会 EPERM */
  private saving: Promise<void> = Promise.resolve()
  /** 最近一次落盘的失败；写成了清空。submit 靠它兑现「账落不了盘整批拒」 */
  private lastPersistError: unknown = undefined
  /** 启动对账那一次。submit 先等它——不等的话首笔账可能赶在旧账载入前落盘，把旧账冲掉 */
  private loadPromise: Promise<void> = Promise.resolve()

  constructor(ctx: GwbContext) {
    super(ctx, 'gwbPdf2md')
    this.own = ctx
    const logger = ctx.logger(PLUGIN_NAME)
    this.info = (message: string): void => logger.info(message)
    this.warn = (message: string): void => logger.warn(message)
  }

  [Service.init](): void {
    // 件卸载：还在跑的作业全部打断、记 interrupted——不丢账、不假装还在跑
    this.own.effect(() => () => {
      for (const controller of this.controllers.values()) controller.abort()
      void this.settleInterrupted().catch(() => undefined)
    })

    // 声明那一格设置。define 回注销函数，effect 包着走自动摘
    this.own.effect(() => this.own.gwbSettings.define(TOKEN_DEF))

    const cli = this.own.gwbCommands
    if (cli === undefined) return
    this.own.effect(() =>
      cli.register(
        { name: 'pdf2md.submit', description: '提交一批 PDF 转 markdown 作业：{ files: [{ input, outDir, overwrite? }, …] }。秒回作业号数组；作业各自独立同时跑，成败看 pdf2md.status。outDir 里已有产物时默认拒，要覆盖得显式 overwrite: true（旧产物先备份）', plugin: PACKAGE_NAME },
        async (args) => {
          const raw = isRecord(args) ? args : {}
          const files = raw['files']
          if (!Array.isArray(files) || files.length === 0) throw new Error('pdf2md.submit 要 { files: [{ input, outDir }, …] } 非空数组')
          const parsed: Pdf2mdSubmitInput[] = []
          for (const one of files) {
            if (!isRecord(one) || typeof one['input'] !== 'string' || typeof one['outDir'] !== 'string') {
              throw new Error('files 里每一项都得是 { input, outDir }（绝对路径）')
            }
            const overwrite = one['overwrite']
            if (overwrite !== undefined && typeof overwrite !== 'boolean') throw new Error('files 里 overwrite 是布尔值（要不要覆盖已有的 outDir）')
            parsed.push({ input: one['input'], outDir: one['outDir'], ...(overwrite === true ? { overwrite: true } : {}) })
          }
          return this.submit(parsed)
        },
      ),
    )
    this.own.effect(() =>
      cli.register({ name: 'pdf2md.jobs', description: '全部转换作业（新的在前）', plugin: PACKAGE_NAME }, () => ({
        count: this.table.size,
        jobs: this.list(),
      })),
    )
    this.own.effect(() =>
      cli.register({ name: 'pdf2md.status', description: '查一条转换作业：{ id }。云端解析中带 progress（已解析页 / 总页）', plugin: PACKAGE_NAME }, (args) => {
        const raw = isRecord(args) ? args : {}
        const id = raw['id']
        if (typeof id !== 'string' || id === '') throw new Error('pdf2md.status 要 { id: string }')
        const job = this.get(id)
        if (job === undefined) throw new Error(`没有这个作业：${id}`)
        return job
      }),
    )
    this.own.effect(() =>
      cli.register(
        { name: 'pdf2md.recover', description: '用作业盘上那份原始 zip 重新解包进它的 outDir：{ id }。零云端、零额度——只对 failed / interrupted 且账上有 archive 的作业有效', plugin: PACKAGE_NAME },
        async (args) => {
          const raw = isRecord(args) ? args : {}
          const id = raw['id']
          if (typeof id !== 'string' || id === '') throw new Error('pdf2md.recover 要 { id: string }')
          return this.recover(id)
        },
      ),
    )

    // 说明书那一格，局部注入：没装 skills 件的 home 里作业机照常挂
    this.own.inject(['gwbSkills'], (scoped) => {
      scoped.effect(() => scoped.gwbSkills.register(new URL('../skills/', import.meta.url)))
    })

    // 启动对账：上一次运行留下的非终态作业，如今没人再轮询了。promise 存下来给
    // submit 当门槛——旧账没对完之前收新作业，首笔落账会把还没载入的旧账冲掉
    this.loadPromise = this.load().catch(() => undefined)
    this.info('mineru 作业机就绪（ctx.gwbPdf2md，件 gwb-mineru）')
  }

  /**
   * 提交一批转换作业。验完全部、落完账才返回——**返回不是完成**，作业各自独立、同时开跑。
   * 传坏形状（路径不是绝对、文件不存在、超 200MB、token 没配）整批当场拒，不落半批账；
   * 两条作业瞄着同一个 outDir、或 outDir 里已有产物而没带 overwrite，同样整批当场拒。
   * 账落不了盘也整批拒并撤回入列——回了作业号就是「跨重启查得到」的承诺，兑现不了就别回。
   * 这里的同步段只有本地验证与一次落账（毫秒级）——「秒回」约束挡的是分钟级云端解析，不冲突
   */
  async submit(files: readonly Pdf2mdSubmitInput[]): Promise<Pdf2mdJob[]> {
    if (!Array.isArray(files) || files.length === 0) throw new Error('submit 要 files: [{ input, outDir }, …] 非空数组')
    const token = this.token()
    if (token === undefined) throw new Error('MinerU token 没配——先在设置里填，或 settings.set { section: "mineru", key: "token", value: "…" }')

    // 占位必须在第一个 await 之前：两个并发 submit 不能都验到「这个 outDir 空着」，否则两条作业
    // 并排往同一个目录里解，先 done 的那条账当场不准
    const at = nowIso()
    const jobs: Pdf2mdJob[] = []
    for (const one of files) {
      if (typeof one?.input !== 'string' || typeof one?.outDir !== 'string') {
        throw new Error('files 里每一项都得是 { input, outDir }（绝对路径）')
      }
      const id = `${at.replaceAll(/[-:TZ.]/g, '').slice(0, 14)}-${String(++this.jobSeq)}`
      jobs.push({
        id,
        input: one.input,
        outDir: one.outDir,
        state: 'queued',
        createdAt: at,
        updatedAt: at,
        ...(one.overwrite === true ? { overwrite: true } : {}),
      })
    }

    const held: string[] = []
    try {
      const batch = new Map<string, string>()
      for (const job of jobs) {
        const key = path.resolve(job.outDir)
        const twin = batch.get(key)
        if (twin !== undefined) {
          throw new Error(`这批里两条作业（${twin} 与 ${job.id}）瞄着同一个 outDir：${job.outDir}——一个 outDir 一次只落一个作业的产物，分开交或各给一个目录`)
        }
        const holder = this.claims.get(key)
        if (holder !== undefined) {
          throw new Error(`outDir 正被作业 ${holder} 占着：${job.outDir}——等它落定（pdf2md.status { id: "${holder}" }）再交，或换个目录`)
        }
        batch.set(key, job.id)
      }
      for (const job of jobs) {
        const key = path.resolve(job.outDir)
        this.claims.set(key, job.id)
        held.push(key)
      }
      for (const one of files) {
        if (!path.isAbsolute(one.input)) throw new Error(`input 得是绝对路径：${one.input}`)
        if (!path.isAbsolute(one.outDir)) throw new Error(`outDir 得是绝对路径：${one.outDir}`)
        const fileStat = await stat(one.input).catch(() => undefined)
        if (fileStat === undefined || !fileStat.isFile()) throw new Error(`input 不是个能读的文件：${one.input}`)
        if (fileStat.size > MAX_FILE_BYTES) throw new Error(`input 超过 MinerU 单文件上限 200MB，拆小了再提：${one.input}`)
        await this.assertOutDirWritable(one.outDir, one.overwrite === true)
      }
      await this.loadPromise

      for (const job of jobs) {
        this.table.set(job.id, job)
        this.info(`作业 ${job.id} 入列：${path.basename(job.input)} → ${job.outDir}${job.overwrite === true ? '（覆盖：旧产物先备份）' : ''}`)
      }
      await this.persist()
      if (this.lastPersistError !== undefined) {
        // 撤账再拒：内存账当场干净。盘上多写的几条 queued 无人开跑，重启对账会标 interrupted
        for (const job of jobs) this.table.delete(job.id)
        throw new Error(`作业账落不了盘，这批不收（重试前先看数据盘）：${describeError(this.lastPersistError)}`)
      }
    } catch (err) {
      for (const key of held) this.claims.delete(key)
      throw err
    }
    for (const job of jobs) this.start(job, token)
    return jobs
  }

  /**
   * 凭作业盘上那份原始 zip 重新解包进它的 outDir。**零云端、零额度**：归档是下载阶段就落好的，
   * 这条路只在本地重走一遍围栏 + 原子提交，不重新报名、不上传、不轮询。
   * 只对 failed / interrupted 的作业有效（done 的产物已经在 outDir 里，在跑的别插手）；
   * 账上没有 archive 的（上传或轮询阶段就挂了的）也无从谈起——那种要结果只能重新 submit，会再花额度。
   */
  async recover(id: string): Promise<Pdf2mdJob> {
    const job = this.table.get(id)
    if (job === undefined) throw new Error(`没有这个作业：${id}`)
    if (job.state === 'done') throw new Error(`作业 ${id} 已经是 done，产物就在 ${job.outDir}，不用重新解包`)
    if (job.state === 'queued' || job.state === 'uploading' || job.state === 'running') {
      throw new Error(`作业 ${id} 还在跑（${job.state}），别插手——等它落定（pdf2md.status { id: "${id}" }）再说`)
    }
    const archive = job.archive
    if (archive === undefined) {
      throw new Error(`作业 ${id} 还没下载过结果 zip，盘上没有归档——要结果只能重新 pdf2md.submit 一次（会再花一次云端额度）`)
    }
    const info = await stat(archive).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new Error(`作业 ${id} 的归档不在了：${archive}——工作根被清过就重新解包不了，只能重新 submit`)

    const key = path.resolve(job.outDir)
    const holder = this.claims.get(key)
    if (holder !== undefined) {
      throw new Error(`outDir 正被作业 ${holder} 占着：${job.outDir}——等它落定再来`)
    }
    this.claims.set(key, id)
    try {
      const extracted = await extractArchive(archive, job.outDir, extractOptions(job))
      await this.finish(id, 'done', extractReceipt(extracted))
      this.info(`作业 ${id} 用盘上归档重新解包完成：${extracted.markdown}（${extracted.lang}，${extracted.commit}）`)
    } catch (err) {
      await this.finish(id, 'failed', undefined, describeError(err))
      throw err
    } finally {
      this.release(job.outDir, id)
    }
    return this.table.get(id) ?? job
  }

  get(id: string): Pdf2mdJob | undefined {
    return this.table.get(id)
  }

  list(): Pdf2mdJob[] {
    return [...this.table.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /** token 现取现读：settings 改值不重挂件就生效 */
  private token(): string | undefined {
    const value = this.own.gwbSettings?.get('token')
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }

  /**
   * outDir 这一格现在收不收这条作业：是个文件、或里面已经有东西而没带 overwrite——当场拒。
   * 提交点还会再查一遍（那才是权威的：本地验完到云端跑完隔着分钟级，中间谁都可能往里放东西）
   */
  private async assertOutDirWritable(outDir: string, overwrite: boolean): Promise<void> {
    const info = await stat(outDir).catch(() => undefined)
    if (info === undefined) return
    if (!info.isDirectory()) throw new Error(`outDir 是个文件，不是目录：${outDir}`)
    if (overwrite) return
    const leftovers = await readdir(outDir)
    if (leftovers.length > 0) {
      throw new Error(`outDir 里已经有 ${String(leftovers.length)} 项东西：${outDir}——要覆盖就在这条里写 "overwrite": true（旧产物先整体备份到工作根），或者换一个空目录`)
    }
  }

  /** 放掉一个 outDir 的占用。只放自己占的那一格：别人的作业占着时不许顶掉 */
  private release(outDir: string, id: string): void {
    const key = path.resolve(outDir)
    if (this.claims.get(key) === id) this.claims.delete(key)
  }

  /** 一条作业的全链：报名 → 上传 → 轮询 → 下载解包，每步落账，终态推 UI 事件。
   * 作业各跑各的、互不排队——云端本来就是一个任务一个任务地转 */
  private start(job: Pdf2mdJob, token: string): void {
    void this.run(job, token).catch(async (err: unknown) => {
      // run 自己管状态收尾，这里只兜「run 自己炸了」的那种没人接的异常
      this.warn(`作业 ${job.id} 的执行链炸了：${describeError(err)}`)
      await this.finish(job.id, 'failed', undefined, describeError(err))
    })
  }

  private async run(job: Pdf2mdJob, token: string): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    try {
      await this.finish(job.id, 'uploading')
      const fileName = path.basename(job.input)
      const [batchId, uploadUrl] = await requestUpload(token, fileName)
      await this.finish(job.id, 'uploading', { batchId })
      await upload(uploadUrl, job.input)

      await this.finish(job.id, 'running')
      const result: FileResult = await poll(token, batchId, {
        interval: POLL_INTERVAL_S,
        stallTimeout: POLL_STALL_S,
        timeout: POLL_TIMEOUT_S,
        onProgress: (pending) => this.noteProgress(job.id, pending),
        signal: controller.signal,
      })
      if (!isDone(result)) {
        await this.finish(job.id, 'failed', undefined, result.err_msg ?? `解析状态 ${result.state}`)
        return
      }

      const extracted = await this.extract(job, result.full_zip_url ?? '')
      if (extracted === undefined) return
      const seen = this.get(job.id)?.progress
      await this.finish(job.id, 'done', {
        ...extractReceipt(extracted),
        ...(seen !== undefined ? { progress: { extractedPages: seen.totalPages, totalPages: seen.totalPages } } : {}),
      })
      this.info(`作业 ${job.id} 转换完成：${extracted.markdown}（${extracted.lang}，${String(extracted.files.length)} 个文件，${extracted.commit}）`)
    } finally {
      this.controllers.delete(job.id)
    }
  }

  /**
   * 下载 + 解包那一段。解包失败落成 failed 并**记下归档路径**——云端那份结果已经在盘上了，
   * 重新解包凭它（pdf2md.recover），不必再花一次额度。归档没落盘就失败（下载就没成）时无路可走，
   * 如实写原因。返回 undefined 表示这条作业已经结算掉了
   */
  private async extract(job: Pdf2mdJob, zipUrl: string): Promise<ExtractResult | undefined> {
    try {
      return await downloadExtract(zipUrl, job.outDir, extractOptions(job))
    } catch (err) {
      const archive = err instanceof ArchiveError ? err.archive : undefined
      await this.finish(job.id, 'failed', archive !== undefined ? { archive } : undefined, describeError(err))
      return undefined
    }
  }

  /** 轮询回包带来的进度：变了才落账，没变不写盘。只记账不推事件 */
  private noteProgress(id: string, result: FileResult): void {
    const cloud = result.extract_progress
    const prev = this.table.get(id)
    if (cloud === null || prev === undefined) return
    if (prev.progress?.extractedPages === cloud.extracted_pages && prev.progress.totalPages === cloud.total_pages) return
    const progress = { extractedPages: cloud.extracted_pages, totalPages: cloud.total_pages }
    this.table.set(id, { ...prev, progress, updatedAt: nowIso() })
    void this.persist()
  }

  /** 状态推进 + 落账。终态事件在**账落盘之后**才发——事件说「完成了」，账就得已经写上 */
  private async finish(id: string, state: JobState, extra?: Partial<Pdf2mdJob>, error?: string): Promise<void> {
    const prev = this.table.get(id)
    if (prev === undefined) return
    const next: Pdf2mdJob = { ...prev, ...extra, state, updatedAt: nowIso(), ...(error !== undefined ? { error } : {}) }
    this.table.set(id, next)
    // 到终态就放掉 outDir 的占用：下一份产物可以进来了（已有产物那一关由提交点自己把）
    if (state === 'done' || state === 'failed' || state === 'interrupted') this.release(next.outDir, id)
    await this.persist()
    if (state === 'done' || state === 'failed') {
      requireKernel(this.own).emit({
        source: PLUGIN_NAME,
        type: 'job-settled',
        jobId: id,
        ok: state === 'done',
        outDir: next.outDir,
        ...(next.error !== undefined ? { error: next.error } : {}),
      })
      if (state === 'failed') this.warn(`作业 ${id} 失败：${next.error ?? '没说原因'}`)
    }
  }

  /** 作业账落盘，排队写：每次写的是轮到那一刻的整张账。失败不抛（后台链还在跑），
   *  记进 lastPersistError 给 submit 当拒收依据 */
  private persist(): Promise<void> {
    this.saving = this.saving.then(async () => {
      try {
        await this.own.gwbData?.writeDoc(JOBS_DOC, { jobs: this.list() })
        this.lastPersistError = undefined
      } catch (err: unknown) {
        this.lastPersistError = err
        this.warn(`作业账落盘失败（继续在内存里跑）：${String(err)}`)
      }
    })
    return this.saving
  }

  /** 启动对账：把上次留下的非终态作业标 interrupted */
  private async load(): Promise<void> {
    const doc = await this.own.gwbData?.readDoc(JOBS_DOC).catch(() => undefined)
    if (!isRecord(doc) || !Array.isArray(doc['jobs'])) return
    let changed = false
    for (const raw of doc['jobs']) {
      if (!isRecord(raw)) continue
      const record = raw as unknown as Pdf2mdJob
      if (typeof record.id !== 'string' || typeof record.input !== 'string') continue
      if (record.state === 'queued' || record.state === 'uploading' || record.state === 'running') {
        this.table.set(record.id, { ...record, state: 'interrupted', updatedAt: nowIso(), error: '宿主重启，作业没人接着跑' })
        changed = true
      } else {
        this.table.set(record.id, record)
      }
    }
    if (changed) {
      this.info(`启动对账：${String(this.table.size)} 条作业入账，其中非终态已标 interrupted`)
      await this.persist()
    } else if (this.table.size > 0) {
      this.info(`启动对账：${String(this.table.size)} 条作业入账`)
    }
  }

  private async settleInterrupted(): Promise<void> {
    let changed = false
    for (const job of this.table.values()) {
      if (job.state === 'queued' || job.state === 'uploading' || job.state === 'running') {
        this.table.set(job.id, { ...job, state: 'interrupted', updatedAt: nowIso(), error: '件卸载，作业被打断' })
        this.release(job.outDir, job.id)
        changed = true
      }
    }
    if (changed) await this.persist()
  }
}

declare module 'cordis' {
  interface Context {
    gwbPdf2md: GwbPdf2mdApi
  }
}
