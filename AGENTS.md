# gwb-mineru

gwb 内核线（单元 `26090705ymz`）的 MinerU 转换件：`pdf2md` 服务（`ctx.gwbPdf2md`），
PDF 经 MinerU 云端转 markdown。**件名是引擎（gwb-mineru）、服务与命令是功能（pdf2md.\*），
名不对应是有意例外**——消费方 inject 的永远是 `gwbPdf2md`。零库概念：输入 PDF 绝对路径
与输出目录，产出 markdown + `images/`；不认识 papers（它在代码里局部注入本件）。

## 怎么跑

```powershell
pnpm install && pnpm build && pnpm typecheck   # 门禁：build + typecheck，绿了才提交
cd docs-site; pnpm dev                         # 文档站，http://localhost:4317
pnpm exec docfirst check                       # 钉码门禁，单独跑，红了提交不许推
```

进 home：`plugin-manager.install {"pkg":"@godcreator/gwb-mineru"}`。凭据：settings 节 `mineru`、
键 `token`（secret，mineru.net 的 API 管理页创建）。包发 gitea 个人源，scope 路由住用户级
`~/.npmrc`，仓里不配。改一版看一版走 `devkit.dev` 进隔离 home，真链路要真 token。

## 硬约束

* **零库概念不许破**：不认识 papers、不做归档与成品命名、不做结果缓存——产出原样落
  调用方给的 outDir，交出去的就三样（markdown 文件名、lang、文件清单）
* **submit 必须秒回**：作业号数组先回、后台各跑各的，绝不把分钟级云端解析放进一次同步调用
* **失败不自动重试**：失败原因如实进作业的 `error`；处置（重提）归调用方
* **作业全并行、不聚合**：一次交 N 篇就是 N 个独立单文件任务，各自全链跑——聚合进一个
  云端 batch\_id 是实测否掉的形状（解析连带失败）；网络抖动与并发无关（单发也撞、重试即过），
  防护靠 error 带 cause，不靠限流（见文档站轨迹区 parallel-and-serial-overturned 那张卡）
* **写盘排队不许拆**：多作业并行推进时作业账写盘排一条链——并发 rename 同一个 jobs.json
  撞过 EPERM
* **设置项必须在 init 里 `define`**：不声明 get 永远 undefined、不报错（撞过，见文档站
  轨迹区那面墙）
* **轮询不许退回短墙钟**：失败只看云端进度停滞与总上限——墙钟误杀长文档，调用方重提就重复
  扣额度（见文档站轨迹区 0.2.0 那张卡）

## 代码地图

`src/index.ts`（作业机：状态机、账、命令、事件）→ `src/core/mineru.ts`（云端三动作）→
`src/core/extract.ts`（zip 解包 + CJK 语言判定）。后两块是纯函数模块、互不认识；细节读
文档站现状区三页。

## 生成物与实验材料

* 仓根 `README.md` 与这份 `AGENTS.md` 都是**生成物**，正本在 `docs-site/content/outputs/`，
  改正本后在 `docs-site` 跑 `pnpm exec docfirst render` 重摆，同提交
* 实验与测量的材料落仓根 `probes/<时间戳>_<目的>/`：一次实验一个目录、自包含（自带依赖，
  不进 pnpm workspace）、进 git、不进 docfirst check；evidence 卡在依据段用相对仓根的
  路径指过去，判据见 trajectory skill
* 轨迹卡（`docs-site/content/trajectory/`）只增不改、正文不许钉码

写或改文档站之前读 docfirst-docs 说明书（经 gwb-docfirst-workflow 件开出，或读
`D:\unitfolders\26090315xby\god-live-doc\docs-site\content\outputs\skills\` 包内正本）。
