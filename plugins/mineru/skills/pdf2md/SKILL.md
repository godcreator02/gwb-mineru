---
name: pdf2md
description: 要把一个或一批 PDF 文件原样转成 markdown 时读。submit 收数组秒回作业号、作业各自独立全并行、成败看 status，讲清轮询节奏与进度、token 缺席与失效会怎么挡、outDir 的占用与覆盖规矩、产出落在哪、解包失败怎么零额度重解。论文的转换与翻译不走这篇——那是 paper-fetch 的事。
---

# PDF 转 markdown（MinerU 作业机）

件叫 `gwb-mineru`（引擎命名），提供的服务叫 `pdf2md`（功能命名）——命令前缀
`pdf2md.*`、inject 写 `gwbPdf2md`，说的都是功能那半边。

通用转换：输入一组「PDF 绝对路径 + 输出目录」，每篇产出完整 markdown + `images/`
原样落各自的 outDir。云端跑（MinerU 精准解析 API，vlm 模型，公式表格都开，语言 ch 中英混合），
**分钟级**——所以是作业不是同步命令。

## 怎么用

1. **提交**：`pdf2md.submit { "files": [{ "input": "D:/…/xxx.pdf", "outDir": "D:/…/out" }, …] }`
   ——files 是非空数组，每项两个绝对路径，单个 PDF 不超过 200MB。**秒回作业号数组，
   返回 ≠ 完成**。多篇一起交：**作业各自独立、同时跑**（云端各转各的，互不排队），
   `pdf2md.jobs` 里多条 `running` 是常态。数组里有一条坏形状（路径不对、文件不在、超 200MB）
   **整批当场拒**，不落半批账
2. **轮询**：`pdf2md.status { "id": "<作业号>" }`。状态机
   `queued → uploading → running → done | failed | interrupted`。`running` 时带
   `progress: { extractedPages, totalPages }`（云端排队时还没有）。十页上下的论文通常半分钟内
   done，多篇并行时总墙钟≈最慢的那篇；问的间隔 5–10 秒就够；终态后别再问。
3. **看全部**：`pdf2md.jobs {}`。
4. **重解**：`pdf2md.recover { "id": "<作业号>" }`——解包那一步失败时的补课，见下面「坑四条」。

done 的作业带三样产出：`markdown`（outDir 里那份完整 markdown 的文件名，通常是
`full.md`）、`lang`（zh/en，按 CJK 占比判）、`files`（落盘文件清单）。正文里的图是
`images/xxx` 相对链接，跟 md 同层，不用改。账上另有三格交代怎么落的：`commit`
（`created` 新建 / `replaced` 覆盖了旧产物）、`backup`（覆盖时旧产物挪去的备份目录）、
`skipped`（zip 根上没搬的杂项，如 `layout.json`）。

## outDir 的两条规矩

- **一个 outDir 一次只落一个作业**：同一批里两条瞄着同一个 outDir、或撞上一条还在跑的作业，
  整批当场拒（话里点名是谁占着）。一个 PDF 一个目录，别让两条作业往一处落
- **已有产物默认拒**：outDir 里已经有东西时，提交阶段就拒——要覆盖就在那一项上显式写
  `"overwrite": true`：旧产物整份先挪进 outDir 同级工作根的 `backup-<时间戳>/`，再上新的。
  产物是**整份出现**的（解包在工作根 staging 里做完再整体落位），不会出现新旧混着的半份；
  `outDir` 不必预先建，第一份产物落位那一刻它才出现

## 坑四条

- **token 缺席当场挡**：submit 报「MinerU token 没配」就去配——
  `settings.set { "section": "mineru", "key": "token", "value": "…" }`
  （值是 secret，status 与日志里永远看不到它）
- **token 失效挡不住，作业几秒内 failed**：error 里是 `code=A0211` 加一句换 token 的话。
  去 mineru.net 的 API 管理页换一个、settings.set 填上、重提
- **`interrupted`**：宿主重启或件卸载把作业打断了——MinerU 侧可能其实做完了，但结果
  没人取。重提一次作业就是了（同一个 PDF 再 submit 一遍）
- **解包失败不用重提，先看 `recover`**：结果 zip 一抓下来就在 outDir 同级
  `.<outDir 名>.pdf2md/archive-<作业号>.zip` 留了一份。作业 `failed` 且账上有 `archive` 时，
  `pdf2md.recover { id }` **零云端零额度**地把解包重走一遍（重新报名/上传/轮询一样都不做）。
  只有 done 的（产物已在）、还在跑的、以及压根没走到下载的（账上没归档）会被挡回来——最后
  那种才需要重提。`failed` 的 error 里也写着归档路径与这句话

## 失败原因与云端错

失败原因看 `error`：上传失败、解析失败、云端停滞（解析中页数 10 分钟不动）或超时
（连云端排队 1 小时）、超 200 页、当天任务数到顶、zip 里某条 entry 犯围栏（报出是哪条、犯的
哪条）、outDir 被人占了，都在那一格，日志里也有同一句。认得出的云端错误码后面附着照着就能做
的话；`fetch failed` 括号里是网络层的真原因——mineru.net 连接偶发抖动，与并发无关（单发也撞、
重试即过），看到它重提就好。

## 界面通知

作业落定时界面上会收到一条事件（`source: "gwb-mineru"`，`type: "job-settled"`）。
进度不推事件。命令轮询照样要——事件是给看着界面的人的，不是给 agent 的回执。

## 论文库不走这篇

论文的转换与翻译走 gwb-paper-fetch 那条链（`paper-fetch.convert`，它自己在代码里调
`gwbPdf2md` 服务，产物进论文库）。这篇只管「一个孤立 PDF（或一批）想要 markdown」。
