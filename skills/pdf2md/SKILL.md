---
name: pdf2md
description: 要把一个 PDF 文件原样转成 markdown 时读。submit 秒回作业号、作业串行排队、成败看 status，讲清轮询节奏与进度、token 缺席与失效会怎么挡、失败或打断后先 resume 续取不重花额度、产出落在哪。论文的转换与翻译不走这篇——那是 paper-fetch 的事。
---

# PDF 转 markdown（MinerU 作业机）

件叫 `gwb-mineru`（引擎命名），提供的服务叫 `pdf2md`（功能命名）——命令前缀
`pdf2md.*`、inject 写 `gwbPdf2md`，说的都是功能那半边。

通用转换：输入一个 PDF 绝对路径、一个输出目录，产出完整 markdown + `images/`
原样落 outDir。云端跑（MinerU 精准解析 API，vlm 模型，公式表格都开，语言 ch 中英混合），
**分钟级**——所以是作业不是同步命令。

## 怎么用

1. **提交**：`pdf2md.submit { "input": "D:/…/xxx.pdf", "outDir": "D:/…/out" }`
   ——两个都得是绝对路径，PDF 不超过 200MB。**秒回作业号，返回 ≠ 完成**。
   一批可以一口气全交：**作业串行**，一次只跑一个，其余停在 `queued` 等着——别自己排队，
   也别并发去催
2. **轮询**：`pdf2md.status { "id": "<作业号>" }`。状态机
   `queued → uploading → running → done | failed | interrupted`。`running` 时带
   `progress: { extractedPages, totalPages }`（云端排队时还没有）。十页上下的论文通常半分钟内
   done（排在后面的要加上前面的时间），问的间隔 5–10 秒就够；终态后别再问。
3. **续取**：`failed` / `interrupted` 的作业先 `pdf2md.resume { "id": "<作业号>" }`——凭账上
   batchId 原批次取回，**不重花额度**，秒回翻回 `queued`、照常轮询 status。被拒就听回执的话：
   没走到上传完成的、云端任务已过期的，重新 submit。
4. **看全部**：`pdf2md.jobs {}`。

done 的作业带三样：`markdown`（outDir 里那份完整 markdown 的文件名，通常是
`full.md`）、`lang`（zh/en，按 CJK 占比判）、`files`（落盘文件清单）。正文里的图是
`images/xxx` 相对链接，跟 md 同层，不用改。

## 坑四条

- **token 缺席当场挡**：submit 报「MinerU token 没配」就去配——
  `settings.set { "section": "mineru", "key": "token", "value": "…" }`
  （值是 secret，status 与日志里永远看不到它）
- **token 失效挡不住，作业几秒内 failed**：error 里是 `code=A0211` 加一句换 token 的话。
  去 mineru.net 的 API 管理页换一个、settings.set 填上、重提
- **`interrupted`**：宿主重启或件卸载把作业打断了——MinerU 侧可能其实做完了，结果还在。
  **先 `pdf2md.resume` 续取**（原批次取回，不重花额度）；resume 被拒（没走到上传完成）才是
  重提一次的事。
- **失败原因看 `error`**：上传失败、解析失败、云端停滞（解析中页数 10 分钟不动）或超时
  （连云端排队 1 小时）、超 200 页、当天任务数到顶、云端任务过期、zip 结构不对，都在那一格，
  日志里也有同一句。认得出的云端错误码后面附着照着就能做的话；`fetch failed` 括号里是网络层的真原因

## 界面通知

作业落定时界面上会收到一条事件（`source: "gwb-mineru"`，`type: "job-settled"`）。
进度不推事件。命令轮询照样要——事件是给看着界面的人的，不是给 agent 的回执。

## 论文库不走这篇

论文的转换与翻译走 gwb-paper-fetch 那条链（`paper-fetch.convert`，它自己在代码里调
`gwbPdf2md` 服务，产物进论文库）。这篇只管「一个孤立 PDF 想要 markdown」。
