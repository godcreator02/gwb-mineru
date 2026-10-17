gwb-mineru 是 gwb 工作台的插件：提供服务 `gwbPdf2md` 与命令 `pdf2md.*`，把 PDF 交给 MinerU 云端转成 markdown。
插件名说干活的是 MinerU，服务与命令说干的是什么，名字不对应是有意的——消费方 inject 的永远是 `gwbPdf2md`。
输入一个 PDF 绝对路径与一个输出目录，产出 markdown 与 `images/`；不认识论文库（gwb-paper-fetch 的说明书让 agent 直接调 `pdf2md.submit`）。

写插件、在隔离 home 里验证读说明书 `gwb-devkit`，升版本号、发版读 `gwb-release`，写文档内容读 `docs-writing`，对文档站执行命令（核对、确认、生成）读 `docs-site`。

## 怎么跑

```powershell
pnpm install && pnpm check                     # 仓根：对 plugins/* 逐个 typecheck，再构建并跑单测
pnpm build                                     # esbuild（build.ts）输出 js 并打包 adm-zip，tsc 只输出类型声明
cd docs-site; pnpm doc                         # 钉码检查；doc:confirm 写回挪了位置的钉码，doc:render 重新生成生成物
cd docs-site; pnpm build                       # 文档站（god-docsite + docfirst）的构建，只作提交前的检查
```

看文档站页面由工作台托管开发服务：`docsite.site.add {"dir":"<站目录>"}`，地址以 `docsite.site.list` 回的 `url` 为准，不在会话里自己 `pnpm dev`。

装进 home：`plugin-manager.install {"pkg":"@godcreator/gwb-mineru"}`；`devkit.dev` / `devkit.release` 的 `packages` 写 `["plugins/mineru"]`。
凭据是设置节 `mineru` 的 `token`（secret，mineru.net 的 API 管理页创建），在隔离 home 里要调用真实的 MinerU 云端，就得配上真实的 token。

## 硬约束

- **不认识论文库**：不知道论文库的存在、不给成品命名、不缓存结果；产物原样放进调用方给的 outDir
- **submit 立即返回**：作业号先回，云端解析放在后台，绝不放进一次同步调用
- **一个 outDir 同一时间只归一条作业**：提交时同步占用，同批冲突或与在跑的作业冲突整批拒；已有产物默认拒，覆盖要显式 `overwrite`
- **产物整份出现**：全部 entry 过了围栏才在工作根的 staging 里解，提交是整个改名；有一条不合格整个 zip 不写
- **原始 zip 先写进工作根**：解包失败后凭它 `pdf2md.recover`，不碰云端——别把重新解包做成重新提交
- **失败不自动重试**：原因如实写进作业的 `error`，要不要重新提交归调用方
- **作业全部同时跑、不合批**：合进一个云端批会连带解析失败；连接抖动与并发无关，应对靠 `error` 带上 `cause`，不靠限流
- **作业账的写盘排成一条链，不许拆**：同一个文件并发改名在 Windows 上报过 EPERM
- **设置项必须在 init 里 `define`**：不声明的话 `get` 永远回 undefined、不报错
- **轮询不许退回短墙钟**：只按云端进度停滞与总上限判失败，否则长文档被误判、调用方重新提交又扣一次额度

## 代码地图

仓根是 private 包，插件包在 `plugins/mineru/`：`src/index.ts`（作业机：状态、作业账、命令、事件、outDir 占用）→
`src/core/mineru.ts`（云端客户端）与 `src/core/extract.ts`（围栏、整份提交、归档、语言判定）。后两块互相不认识、不依赖 cordis；
`src/vocab.ts` 是插件自带的 `isRecord` / `requireKernel`（内核包的包根只导出类型）。单测在 `tests/`。
adm-zip 写在 dev、由 esbuild 打包进产物，别挪回 `dependencies`。先读文档站首页的接缝图，再读各模块页。

## 生成物与实验材料

- 仓根 `README.md`、`AGENTS.md`、`CLAUDE.md` 都是生成物，正本在 `docs-site/content/docs/outputs/`，改那边
- 实验与测量的材料放在仓根 `probes/<时间戳>_<目的>/`：一次实验一个目录、自带依赖、不进 pnpm workspace、进 git、不进钉码检查；
  实验结论写成轨迹卡，卡里用相对仓根的路径指过去（见说明书 `trajectory`）
