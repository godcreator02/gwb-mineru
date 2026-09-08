---
name: pdf2md
description: 要把一个 PDF 文件原样转成 markdown 时读。submit 秒回作业号、成败看 status，讲清轮询节奏、token 缺席会怎么挡、产出落在哪。论文库那套入库/升级不在这篇——那是 papers 的事。
---

# PDF 转 markdown（MinerU 作业机）

件叫 `gwb-mineru`（引擎命名），提供的服务叫 `pdf2md`（功能命名）——命令前缀
`pdf2md.*`、inject 写 `gwbPdf2md`，说的都是功能那半边。

通用转换：输入一个 PDF 绝对路径、一个输出目录，产出完整 markdown + `images/`
原样落 outDir。云端跑（MinerU vlm 模型，公式表格都开），**分钟级**——所以是作业不是
同步命令。

## 怎么用

1. **提交**：`pdf2md_submit { "input": "D:/…/xxx.pdf", "outDir": "D:/…/out" }`
   ——两个都得是绝对路径。**秒回作业号，返回 ≠ 完成**。
2. **轮询**：`pdf2md_status { "id": "<作业号>" }`。状态机
   `queued → uploading → running → done | failed | interrupted`；每 5 秒问一次 MinerU，
   单作业上限 300 秒。终态后别再问。
3. **看全部**：`pdf2md_jobs {}`。

done 的作业带三样：`markdown`（outDir 里那份完整 markdown 的文件名，通常是
`full.md`）、`lang`（zh/en，按 CJK 占比判）、`files`（落盘文件清单）。正文里的图是
`images/xxx` 相对链接，跟 md 同层，不用改。

## 坑三条

- **token 缺席当场挡**：submit 报「MinerU token 没配」就去配——
  `settings_set { "section": "mineru", "key": "token", "value": "…" }`
  （值是 secret，status 与日志里永远看不到它）
- **`interrupted`**：宿主重启或件卸载把作业打断了——MinerU 侧可能其实做完了，但结果
  没人取。重提一次作业就是了（同一个 PDF 再 submit 一遍）。
- **失败原因看 `error`**：上传失败、解析失败、轮询超时、zip 结构不对，都在那一格，
  日志里也有同一句。

## 界面通知

作业落定时界面上会收到一条事件（`source: "gwb-mineru"`，`type: "job-settled"`）。
命令轮询照样要——事件是给看着界面的人的，不是给 agent 的回执。

## 论文库不走这篇

把论文 PDF 入库、转换后规格化/翻译，是 papers 件那条链（它自己在代码里调
`gwbPdf2md` 服务，agent 面上只有 `papers.convert`）。这篇只管「一个孤立 PDF 想要
markdown」。
