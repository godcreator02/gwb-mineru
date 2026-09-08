import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { Service } from 'cordis'
import { isRecord, requireKernel, type GwbContext } from '@godcreator02/gwb-plugin-api'
// 只为激活 commands / data / skills / settings 四个件给 cordis Context 加的服务名。
// type-only，运行期不欠它们；static inject 那三个名字靠这些声明才有类型
import type {} from '@godcreator02/gwb-commands'
import type {} from '@godcreator02/gwb-data'
import type {} from '@godcreator02/gwb-settings'
import type {} from '@godcreator02/gwb-skills'
import { downloadExtract } from './core/extract.js'
import { isDone, poll, requestUpload, upload, type FileResult } from './core/mineru.js'

/**
 * PDF 转 markdown：MinerU 云端转换的作业机。**submit 秒回、后台跑完落盘**——
 * 内核那条 fd3 命令通道 120 秒硬超时，分钟级的云端解析绝不能在线等。
 *
 * 零库概念：输入一个 PDF 绝对路径、一个输出目录，产出完整 markdown + images/ 原样落
 * outDir（markdown 文件名、语言判定、文件清单记在作业上）。「归档副本、成品位命名」那套
 * 篇目录布局是调用方（如 papers）的私有约定，不在这儿。
 *
 * 三个邻居服务走 `static inject` 硬依赖（gwb-node-cli 的同款姿势）：settings（token）、
 * data（作业账）、commands（命令那面）。缺谁这个件不挂——比挂上之后半身不遂好查。
 * 用的时候一律 `this.own.<服务>` 现取。**设置项必须在 init 里 define**：不声明的话
 * get 永远回 undefined——实机撞过一轮，症状是「token 明明在 settings.json 里，
 * 命令却报没配」。
 */

const PLUGIN_NAME = 'gwb-pdf2md'
const JOBS_DOC = 'jobs'

/** 轮询节奏与上限（秒），沿用老仓默认 */
const POLL_INTERVAL_S = 5
const POLL_TIMEOUT_S = 300

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
  /** 转换成功后交出的三样 */
  readonly markdown?: string
  readonly lang?: 'zh' | 'en'
  readonly files?: readonly string[]
}

/** 消费方拿到的那一格。写 `inject: ['gwbPdf2md']` 才有 */
export interface GwbPdf2mdApi {
  /**
   * 提交一个转换作业。验完文件与目录、落完账就返回——**返回不是完成**，
   * 成败看 get(id) 的 state。
   */
  submit(input: string, outDir: string): Promise<Pdf2mdJob>
  /** 查一条。没有这个 id 回 undefined */
  get(id: string): Pdf2mdJob | undefined
  /** 此刻账上的全部作业，新的在前 */
  list(): Pdf2mdJob[]
}

/** 设置：一枚凭据，住 pdf2md 节。声明在 init 里——不声明的话 get 永远回 undefined（实机撞过） */
const TOKEN_DEF = {
  key: 'mineru-token',
  title: 'MinerU Token',
  type: 'secret',
  description: 'MinerU 云端转换的 API token，https://mineru.net 申请',
} as const

function nowIso(): string {
  return new Date().toISOString()
}

export default class GwbPdf2md extends Service implements GwbPdf2mdApi {
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
  private readonly controllers = new Map<string, AbortController>()
  private jobSeq = 0

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
        { name: 'pdf2md.submit', description: '提交 PDF 转 markdown 作业：{ input, outDir }。秒回作业号，成败看 pdf2md.status', plugin: PLUGIN_NAME },
        async (args) => {
          const raw = isRecord(args) ? args : {}
          const input = raw['input']
          const outDir = raw['outDir']
          if (typeof input !== 'string' || input === '') throw new Error('pdf2md.submit 要 { input: 绝对路径 }')
          if (typeof outDir !== 'string' || outDir === '') throw new Error('pdf2md.submit 要 { outDir: 绝对路径 }')
          return this.submit(input, outDir)
        },
      ),
    )
    this.own.effect(() =>
      cli.register({ name: 'pdf2md.jobs', description: '全部转换作业（新的在前）', plugin: PLUGIN_NAME }, () => ({
        count: this.table.size,
        jobs: this.list(),
      })),
    )
    this.own.effect(() =>
      cli.register({ name: 'pdf2md.status', description: '查一条转换作业：{ id }', plugin: PLUGIN_NAME }, (args) => {
        const raw = isRecord(args) ? args : {}
        const id = raw['id']
        if (typeof id !== 'string' || id === '') throw new Error('pdf2md.status 要 { id: string }')
        const job = this.get(id)
        if (job === undefined) throw new Error(`没有这个作业：${id}`)
        return job
      }),
    )

    // 说明书那一格，局部注入：没装 skills 件的 home 里作业机照常挂
    this.own.inject(['gwbSkills'], (scoped) => {
      scoped.effect(() => scoped.gwbSkills.register(new URL('../skills/', import.meta.url)))
    })

    // 启动对账：上一次运行留下的非终态作业，如今没人再轮询了
    void this.load().catch(() => undefined)
    this.info('pdf2md 作业机就绪（ctx.gwbPdf2md）')
  }

  async submit(input: string, outDir: string): Promise<Pdf2mdJob> {
    if (!path.isAbsolute(input)) throw new Error(`input 得是绝对路径：${input}`)
    if (!path.isAbsolute(outDir)) throw new Error(`outDir 得是绝对路径：${outDir}`)
    const fileStat = await stat(input).catch(() => undefined)
    if (fileStat === undefined || !fileStat.isFile()) throw new Error(`input 不是个能读的文件：${input}`)
    await mkdir(outDir, { recursive: true })
    const token = this.token()
    if (token === undefined) throw new Error('mineru-token 没配——先在设置里填，或 settings_set { section: "pdf2md", key: "mineru-token" }')

    const id = `${nowIso().replaceAll(/[-:TZ.]/g, '').slice(0, 14)}-${String(++this.jobSeq)}`
    const at = nowIso()
    const job: Pdf2mdJob = { id, input, outDir, state: 'queued', createdAt: at, updatedAt: at }
    this.table.set(id, job)
    this.info(`作业 ${id} 排队：${path.basename(input)} → ${outDir}`)
    void this.persist()
    void this.run(job, token).catch((err: unknown) => {
      // run 自己管状态收尾，这里只兜「run 自己炸了」的那种没人接的异常
      this.warn(`作业 ${id} 的执行链炸了：${String(err)}`)
      void this.finish(id, 'failed', undefined, String(err))
    })
    return job
  }

  get(id: string): Pdf2mdJob | undefined {
    return this.table.get(id)
  }

  list(): Pdf2mdJob[] {
    return [...this.table.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /** token 现取现读：settings 改值不重挂件就生效 */
  private token(): string | undefined {
    const value = this.own.gwbSettings?.get('mineru-token')
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }

  /** 后台全链：申请上传位 → 上传 → 轮询 → 下载解包。每步落账，终态推 UI 事件 */
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
        timeout: POLL_TIMEOUT_S,
        signal: controller.signal,
      })
      if (!isDone(result)) {
        await this.finish(job.id, 'failed', undefined, result.err_msg ?? `解析状态 ${result.state}`)
        return
      }

      const extracted = await downloadExtract(result.full_zip_url ?? '', job.outDir)
      await this.finish(job.id, 'done', { markdown: extracted.markdown, lang: extracted.lang, files: [...extracted.files] })
      this.info(`作业 ${job.id} 转换完成：${extracted.markdown}（${extracted.lang}，${String(extracted.files.length)} 个文件）`)
    } finally {
      this.controllers.delete(job.id)
    }
  }

  /** 状态推进 + 落账。终态时往界面推一条事件（走内核那条 emit 通道，载荷自带 source） */
  private async finish(id: string, state: JobState, extra?: Partial<Pdf2mdJob>, error?: string): Promise<void> {
    const prev = this.table.get(id)
    if (prev === undefined) return
    const next: Pdf2mdJob = { ...prev, ...extra, state, updatedAt: nowIso(), ...(error !== undefined ? { error } : {}) }
    this.table.set(id, next)
    void this.persist()
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

  /** 作业账落盘 */
  private async persist(): Promise<void> {
    try {
      await this.own.gwbData?.writeDoc(JOBS_DOC, { jobs: this.list() })
    } catch (err: unknown) {
      this.warn(`作业账落盘失败（继续在内存里跑）：${String(err)}`)
    }
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
      void this.persist()
    } else if (this.table.size > 0) {
      this.info(`启动对账：${String(this.table.size)} 条作业入账`)
    }
  }

  private async settleInterrupted(): Promise<void> {
    let changed = false
    for (const job of this.table.values()) {
      if (job.state === 'queued' || job.state === 'uploading' || job.state === 'running') {
        this.table.set(job.id, { ...job, state: 'interrupted', updatedAt: nowIso(), error: '件卸载，作业被打断' })
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
