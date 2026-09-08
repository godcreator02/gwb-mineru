# gwb-pdf2md

PDF 转 markdown 件：MinerU 云端转换的作业机，跑在 gwb-kernel（单元 `26090705ymz`）
线上。

**零库概念**——输入一个 PDF 绝对路径、一个输出目录，产出完整 markdown + `images/`
原样落 outDir。不知道 papers 存在；papers（单元 `26090814ifd`）在代码里局部注入
`ctx.gwbPdf2md` 服务做论文转换，agent 不直接碰它。独立用也行：`pdf2md.submit` 命令
就是给「一个孤立 PDF 想要 markdown」的那扇门。

- **作业模式**：`submit` 秒回作业号（总线 120s 硬超时，分钟级云端解析不能在线等）；
  状态机 `queued→uploading→running→done|failed|interrupted`；作业账经 gwbData 落盘、
  重启标 interrupted
- **设置**：`pdf2md` 节一枚 `mineru-token`（secret）
- **事件**：落定时经内核 emit 通道推界面一条 `job-settled`

MinerU 客户端与 zip 解包沿用老仓 god-papers 的接口规格（单元 `26082116etw`，只作
参考）；语言判定（CJK 占比）是通用文本分析，跟着这个件走。

```powershell
pnpm install
pnpm build
```
