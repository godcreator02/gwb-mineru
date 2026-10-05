---
name: pdf2md
description: 要把一个或一批 PDF 原样转成 markdown 时读。submit 收数组、立即返回作业号，作业各自同时跑，成败看 status；讲清轮询节奏与进度、token 没配与失效会怎样、outDir 的占用与覆盖规矩、产物放在哪、解包失败怎么不花额度重解。论文进论文库的整条线（查、下、转、译）先读 paper-fetch，它的转换一步同样调这里的 pdf2md.submit。
---

# PDF 转 markdown（MinerU）

插件叫 `gwb-mineru`（说干活的是 MinerU），服务与命令叫 `pdf2md`（说干的是什么）：命令前缀 `pdf2md.*`，inject 写 `gwbPdf2md`。

输入一组「PDF 绝对路径 + 输出目录」，每篇产出完整 markdown 与 `images/`，原样放进各自的 outDir。解析在 MinerU 云端跑
（精准解析 API，vlm 模型，开公式与表格，语言 `ch` 中英混合），一篇要几十秒到几分钟，所以是作业，不是同步命令。

## 怎么用

1. **提交**：`pdf2md.submit { "files": [{ "input": "D:/…/a.pdf", "outDir": "D:/…/a" }, …] }`。`files` 是非空数组，每项两个绝对路径，
   单个 PDF 不超过 200MB。**立即返回作业号数组，返回不是完成**。多篇一起交时各自同时跑，`pdf2md.jobs` 里多条 `running` 是正常的。
   数组里有一条不合格（路径不对、文件不在、超 200MB）整批当场拒，一条账都不写
2. **查状态**：`pdf2md.status { "id": "<作业号>" }`。状态依次是 `queued`、`uploading`、`running`，终态是 `done`、`failed`、`interrupted`。
   `running` 时带 `progress: { extractedPages, totalPages }`（云端排队时还没有）。十页左右的论文通常半分钟内完成，几篇一起交时总耗时约等于最慢的那篇；
   间隔 5 到 10 秒问一次就够，到了终态别再问
3. **看全部**：`pdf2md.jobs {}`
4. **重新解包**：`pdf2md.recover { "id": "<作业号>" }`，解包那一步失败时用，见下面「出了问题」

`done` 的作业带三样产物：`markdown`（outDir 里那份完整 markdown 的文件名，通常是 `full.md`）、`lang`（`zh` 或 `en`）、`files`（写进 outDir 的文件清单）。
正文里的图是 `images/xxx` 相对链接，跟 markdown 同层，不用改。另有三个字段说明产物怎么进的 outDir：`commit`（`created` 新建、`replaced` 覆盖）、
`backup`（覆盖时旧产物挪去的备份目录）、`skipped`（zip 根上没搬的杂项，如 `layout.json`）。

## outDir 的两条规矩

- **一个 outDir 同一时间只归一条作业**：同一批里两条指向同一个 outDir，或者 outDir 正被一条还在跑的作业占着，整批当场拒，报错里写出占着它的作业号。
  一个 PDF 给一个目录
- **已有产物默认拒**：outDir 里已经有东西时提交就拒；要覆盖，在那一项上写 `"overwrite": true`，旧产物先整个挪进 outDir 旁边工作根里的
  `backup-<时间>/`，再放新的。产物在工作根里解完、最后整个改名成 outDir，不会新旧混在一起；outDir 不用预先建

## 出了问题

- **token 没配，提交当场拒**：报「MinerU token 没配」。读说明书 `gwb-settings`，在用户授权范围内用 `credentials.copy` / `credentials.import` 配置目标 `{ "section": "mineru", "key": "token" }`，或在本地设置界面填写；用 `credentials.status` 核对是否已配置。复制、导入只回状态，agent 可以执行，不必经手原文
- **token 失效，作业几秒内 failed**：`error` 里有 `code=A0211` 与换 token 的那句话。去 mineru.net 的 API 管理页换一个，再经上述入口更新（复制、导入覆盖时明确 `overwrite: true`）、重新提交；随机生成的值不能代替 MinerU 签发的 token
- **`interrupted`**：宿主重启或插件卸载打断了作业。账上有 `archive` 的用 `recover`；没有的把同一个 PDF 再提交一次
- **解包失败先看 `recover`，不用重新提交**：结果 zip 一下载下来就在 outDir 旁边留了一份 `.<outDir 名>.pdf2md/archive-<作业号>.zip`。作业 `failed` 且账上有 `archive` 时，
  `pdf2md.recover { id }` 用它把解包重做一遍，不申请上传位、不上传、不轮询、不花云端额度。`done` 的、还在跑的、没走到下载的（账上没有 `archive`）会被拒；
  最后那种才需要重新提交

失败原因都在 `error` 里：上传失败、解析失败、云端停滞（解析中页数 10 分钟不动）或超时（连排队 1 小时）、超 200 页、当天任务数到上限、
zip 里某条 entry 过不了围栏（写明是哪条、犯了哪条）、outDir 被别人占了；日志里是同一句。认得出的云端错误码后面附一句照着就能做的话；
`fetch failed` 的括号里是网络层的真正原因——mineru.net 的连接偶尔会断，与并发无关（只交一篇也会遇到，重试就过），看到它重新提交就好。

## 界面通知

作业到 `done` 或 `failed` 时，页面会收到一条事件（`source: "gwb-mineru"`，`type: "job-settled"`）。进度不推事件。
事件给看着界面的人用，agent 照样查 `pdf2md.status`。

## 论文进论文库

论文的整条线（查元数据、下载、转换、翻译、去重）读说明书 `paper-fetch`：它的转换一步也是调这里的 `pdf2md.submit`，
done 之后怎么把产物归置进论文文件夹由那份说明书定。这份只管「一个或一批 PDF 想要 markdown」。
