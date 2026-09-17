# 0.2.0 的轮询与回包解读：假 fetch 验分支 + 隔离 home 真论文实跑

## 问什么

0.2.0 改的三件事是否按设计走：轮询的停滞 / 总上限判定（排队不判停滞）、云端进度落进作业账、业务错（含 401 + msgCode）翻成照着能做的话；以及整条链对真论文是否跑通。

## 怎么跑

```powershell
node probe.mjs
```

这一条是**假 fetch 那半**：零网络零依赖，被测的是冻结在 `input/mineru.js` 的产物（gwb-mineru `eaf1ee1` 构建出的 `dist/core/mineru.js`）。要验仓里当前的代码，把那份换成新构建的再跑。

**实跑那半**要工作台，步骤如下（`runs/02`–`05` 就是这么来的）：`devkit.home.new {"short":"mineru"}` 开隔离 home → 里面 `plugin-manager.install {"pkg":"@godcreator/gwb-mineru"}` → `devkit.dev {"home":"<名>","dir":"<仓根>"}` 换上开发版 → `settings.set` 先填一把坏 token 提交一次、再填真 token 提交中英文各一篇 → `pdf2md.status` / `pdf2md.jobs` 取回执（`node <devkit 包>/bin/cdp.mjs <home> cmd pdf2md.jobs '{}'`）。

## 结论

**假 fetch 六条全按设计**（`runs/01-fake-poll.txt`）：排队 8 轮（0.16s，超过 0.05s 停滞上限）不判停滞、随后 running 3→7 页、done；running 页数一直是 4 → 判停滞 failed；一直排队 → 总上限 failed；`401 + msgCode A0211` → MineruError 附换 token 的话；`200 + code -60018` → 附「明天再提」；纯文本 401 → `HTTP 401 Unauthorized：login required`。

**实跑两篇都 done**：中文 11 页（`稳态负电平输出下的混合型MMC设计方法`，1.2MB）提交到 done 约 24 秒，lang zh；英文 6 页（432KB）约 16 秒，lang en。英文那篇在提交后约 16 秒抓到 `running` 且 `progress: 5/6`（`runs/03-live-en-mid-run.txt`）——**vlm 模型下云端确实给 extract_progress**，停滞判定有数据可看。两篇 done 后 progress 补满（11/11、6/6），刚上传完的首轮轮询没有出现空的 `extract_result`（`runs/04-live-jobs-final.txt`）。坏 token 那次 2 秒内 failed，error 带出 A0211 与换 token 的话（`runs/02-live-bad-token.txt`；那是开发版 `0.1.1-dev.202609172219` 的措辞，连用两个破折号，`eaf1ee1` 已改成句号分隔）。

顺带看到的（没动）：结果 zip 里的 `images/` 文件比正文引用的多——中文那篇 71 个文件、正文引用 17 处，英文 17 对 11（`runs/05-output-stats.txt`）。解包按 0.1.0 以来的规则整目录搬，不影响 markdown 可用。

## 跑那次的环境

2026-09-17 22:19–22:25 +0800，Windows 11 Pro 10.0.26200，node v24.14.1，gwb 安装版内核起的隔离 home `mineru-2609172219`。被测对象 gwb-mineru commit `eaf1ee1`（实跑用的开发版 `0.2.1-dev.202609172221` 就是从这份工作树构建的，提交前后 src 未再改）。
