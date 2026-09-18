# gwb-mineru

MinerU 转换件：提供 **pdf2md 服务**（`ctx.gwbPdf2md`）——PDF 经 MinerU 云端转 markdown，
作业机形态，跑在 gwb-kernel（单元 `26090705ymz`）线上。

**件名与服务名不对应是有意的**：件名说谁在干活（MinerU 引擎），服务名与命令前缀
（`pdf2md.*`）说干的是什么。消费方 inject 的永远是 `gwbPdf2md`。（曾用包名
`@godcreator/gwb-pdf2md` 0.0.1–0.0.3，已废弃更名。）

**零库概念**——输入一个 PDF 绝对路径、一个输出目录，产出完整 markdown + `images/`
原样落 outDir。不知道 papers 存在；papers（单元 `26090814ifd`）在代码里局部注入
`gwbPdf2md` 做论文转换，agent 不直接碰它。独立用也行：`pdf2md.submit` 命令就是给
「一个孤立 PDF 想要 markdown」的那扇门。

* **作业模式**：`submit` 收数组、秒回作业号数组（命令是页面等着的一次调用，分钟级云端解析
  不能在线等）；作业各自独立**全并行**（一次交 N 篇就是 N 个独立任务，云端各转各的）；
  状态机 `queued→uploading→running→done|failed|interrupted`；解析中带云端进度
  （已解析页 / 总页）；作业账经 gwbData 落盘（写盘排队）、重启标 interrupted
* **设置**：`mineru` 节一枚 `token`（secret）
* **事件**：落定时经内核 emit 通道推界面一条 `job-settled`

MinerU 客户端与 zip 解包沿用老仓 god-papers 的接口规格（单元 `26082116etw`，只作
参考）；语言判定（CJK 占比）是通用文本分析，跟着这个件走。

## 跑起来

```powershell
pnpm install
pnpm build          # tsc 直出 dist/
pnpm typecheck
```

进 home：`plugin-manager.install {"pkg":"@godcreator/gwb-mineru"}`（包发 gitea 个人源
`https://git.tianshen02.online:28377/api/packages/godcreator/npm/`）。用之前在设置里配 `mineru` 节的
`token`（mineru.net 的 API 管理页创建）。

## 文档

文档站在 `docs-site/`（docfirst 六区）：

```powershell
cd docs-site
pnpm dev                    # http://localhost:4317
pnpm exec docfirst check    # 钉码门禁，单独跑
```

[轨迹区](/trajectory)记方向了断，一卡一文件、只增不改、不钉码。这份 README 是生成物，
正本是 `docs-site/content/outputs/readme.mdx`，改完在 `docs-site` 跑
`pnpm exec docfirst render` 重摆，一起提交。
