import json
import markdown
from pathlib import Path
root=Path(__file__).parent
rows=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
stats=json.loads((root/'validation.json').read_text(encoding='utf-8'))
text=r'''# MinerU 与 PaddleOCR：10 篇已有论文实测

实验日期：2026-09-29。10 篇、194 页，两边全部完成，Markdown 引用的图片均已落盘。输入来自本机新旧论文库，原库未改动；副本与 SHA-256 见 `manifest.json`。

**本批材料不足以支持全面替换其中一个。** MinerU 的公式编号保留明显更完整，但中文正文中出现缩写、图号漏字，以及英文行内公式损坏；PaddleOCR 在这些正文例子上更好，却出现表格整列数值遗漏，并且绝大多数公式编号没有导出到 Markdown。工程上更适合把第二个引擎用于重点页交叉核对。

[打开三栏对照页](compare.html) · [十篇样张](sample-contact.png) · [机器校验结果](validation.json)

## 样本

不是随机抽样：从 247 个 PDF 路径条目中挑选不同版式与内容，路径条目包含新旧库副本和附录，不代表 247 篇独立论文。最终选择 6 篇英文、4 篇中文；其中 3 篇为整页栅格图像并带文字层的材料。没有人为制造噪声，也没有把电子版转图片冒充真实扫描来源。

|编号|论文|页数|覆盖类型|公式块 M / P|
|---|---|---:|---|---:|
'''
for r,s in zip(rows,stats):
    title=r['title'].replace('_',' ')
    text+=f"|{r['id']}|[{title}](samples/{r['id']}/source.pdf)|{r['pages']}|{r['category']}|{s['mineru_equations']} / {s['paddle_equations']}|\n"
text+=r'''
公式密集样本以 01、02、05、07、10 为主；03、04、06、09 公式相对少。04 的附录有代码、块路径清单；02 有合并单元格和实验数值表。

“扫描”在这里指观察到的 PDF 表示与视觉特征：05、06 是历史论文的整页图像版本，10 是中文学位论文栅格版。它们已有文字层，不能把本次结果推广为无文字层、手机拍照、倾斜/污损扫描件的结果。

## 同一输入与调用方式

- 两引擎读取同一份 `samples/NN/source.pdf`，完整处理，不截取正文或另行压缩。
- MinerU：工作台 `pdf2md.submit`，云端精准解析 `vlm`，说明书约定开启公式/表格、语言 `ch`。服务端精确模型修订号未返回，不能据此声称是某个特定开源版本。
- PaddleOCR：用户提供的异步 API，`PaddleOCR-VL-1.6`；`useDocOrientationClassify=false`、`useDocUnwarping=false`、`useChartRecognition=false`，照用户样例执行。
- Paddle 的图表语义识别关闭；本实验比较图块、图注、表格及公式，没有比较曲线数据还原能力。两服务默认处理链不同，因此这是实际 API 产物对比，并非严格控制全部内部参数的模型消融实验。
- 先检查每篇 2 页样张，再检查差异页；没有逐字标注全部 194 页，也没有全篇人工真值，因此不报告“准确率 99%”或总体胜率。
- 原始返回不修字、不补编号。三栏页的 MinerU 分页内容由 `content_list.json` 重建，只用于按页对照；最终产物以各自 `full.md` 为准。分页边界处段落合并不同，不能只看段落相似度就断言漏文。

## 已对原页确认的差异

### 1. PaddleOCR 大量公式编号在 Markdown 导出时消失

以 **01 / PDF 第 3 页**为例，原页的式 (1)–(5) 均有编号。MinerU 的对应 LaTeX 带 `\tag{1}` 至 `\tag{5}`；PaddleOCR 的五个公式主体仍在，但没有这些编号。其 JSON 中有 `formula_number`，所以应区分“编号未识别”和“编号未导出”：这里主要是后者。

全批 MinerU Markdown 有 **372 个 `\tag{...}`**，PaddleOCR 有 **5 个**；Paddle JSON 有 **378 个 `formula_number` 块**。这些只是格式与结构计数，不能把差额直接当作漏识公式数。少数编号可能以别的表示出现，但该页和多个抽查页确实丢了编号。

[01 第 3 页原图](samples/01/page-003.png) · [MinerU 全文](results/01/mineru/full.md) · [Paddle 第 3 页](results/01/paddle/page-003.md)

### 2. PaddleOCR 漏掉一张表的 Set E 整列四个数据

**02 / PDF 第 13 页 / Table III**：表头保留了 Set A–E，表体却只有四组数值，还少了表头应有的合并列结构。这不是图片下载问题：Markdown 和 `prunedResult` 的表格 HTML 都缺失。

|原表 Set E|MinerU|PaddleOCR|
|---|---|---|
|FBSM / Theoretical：0.80%|保留|缺失|
|FBSM / Experimental：0.86%|保留|缺失|
|HBSM / Theoretical：0.35%|保留|缺失|
|HBSM / Experimental：0.39%|保留|缺失|

![Table III 原页裁切](samples/02/table-III.png)

同篇 **PDF 第 10 页 / Table II** 的 11 行 × 5 组、共 55 个数据值，核对原表后两边均保留。这说明应按表检查，不能因为 Table III 出错就说 Paddle 的所有表格都不行。

[Table II 原图](samples/02/table-II.png) · [Paddle 第 13 页](results/02/paddle/page-013.md) · [MinerU 第 13 页结构文本](results/02/mineru/page-013.txt)

### 3. MinerU 在中文正文中漏掉缩写和图号

**08 / PDF 第 1 页，左栏引言**：原文是“自模块化多电平变换器（MMC）的拓扑结构被提出以来”，MinerU 输出“自模块化多电平变换器（）的拓扑结构被提出以来”；Paddle 保留了 MMC。同一段“MMC 具有更加优越的……”的 MMC 也在 MinerU 中丢失。

**08 / PDF 第 4 页，右栏下部**：原文是“图5为过调制下混合MMC通过二次谐波环流注入实现电容电压平衡的整体控制框图”。MinerU 变成“图为过调制下混合通过……”，漏了 5 和 MMC；Paddle 保留。这些缺字也存在于 MinerU 的 `full.md`，不是对照页重建造成的。

[第 1 页原图](samples/08/page-001.png) · [第 4 页原图](samples/08/page-004.png) · [MinerU 全文](results/08/mineru/full.md) · [Paddle 第 4 页](results/08/paddle/page-004.md)

### 4. MinerU 英文行内公式出现控制字符

**01 / PDF 第 17 页，C. Steady-State Operating Point**：“According to (37), ⟨s₁⟩ and ⟨s₃⟩ are expressed as follows”。MinerU 对应位置含 U+0003 / U+0004 控制字符、`s<sub>1</sub>`，并把第二个尖括号表达式写坏；Paddle 的 `\langle s_1\rangle` 与 `\langle s_3\rangle` 保留了符号含义。

全篇 01、02、03 的 MinerU `full.md` 分别含 11、4、2 个非换行/制表控制字符。这是排查信号，不代表对应数量的独立语义错误。

[第 17 页原图](samples/01/page-017.png) · [MinerU 全文](results/01/mineru/full.md) · [Paddle 第 17 页](results/01/paddle/page-017.md)

### 5. 扫描版正文基本可读，但 Paddle 会改写原文小错误

05 的第 1–3 页，两边都恢复出双栏正文、傅里叶积分和状态方程；原页的公式编号仍以 MinerU 保留得更完整。这只是这些抽查页的结果，不是全部公式正确的证明。

**06 / PDF 第 3 页右下**的原文确实印成 “shown in Fig. 6 an 7.”。MinerU 保留了 “Fig. 6 an 7.”；Paddle 改成 “Fig. 6 and in Fig. 7.”。语义改善了，但并非逐字转录；若要原样存档，应留意这种自动改写。

[06 第 3 页原图](samples/06/page-003.png) · [Paddle 第 3 页](results/06/paddle/page-003.md)

### 6. 少公式、代码清单、长学位论文

03、04 的正文样张没有发现双栏横向串行或整页漏失。03 作者行的 ORCID 图标被 Paddle 写成 `^{ID}`，说明装饰图标可能混入文字；本次不把它与正文漏字等量看待。

04 的附录 A.1 是代码风格的块名称/库路径清单，MinerU 把它归为 `code`，Paddle 主要归为 `algorithm`。两边的表格块计数差异不能直接解释为“多识别了几张正确表格”。

07、09 的中文双栏样张均可恢复正文、图片与公式，但 08 的已确认漏字说明中文英文混排仍需重点复核。10 的 66 页均有输出，正文、目录、参考文献与公式块都在；第 11 / 33 页样张和第 26 页公式页面可在对照页查看。本次未逐字核对整本学位论文。

### 7. Paddle 示例的图片保存方式会产生跨页重名

07 的 PDF 第 8 页和第 10 页都返回 `imgs/img_in_chart_box_651_721_1039_879.jpg`，对应两个不同的下载地址。仅按原示例把 `img_path` 拼到同一个输出目录，不能可靠保存这两个页的图片。

本实验已使用 `pages/008/imgs/...` 与 `pages/010/imgs/...` 分别保存，并仅重写汇总 Markdown 的图片路径；每页的 `pages/NNN/raw.md` 保留原始文本，JSONL 不变。它是接入代码的问题，不计入模型识别质量。[冲突清单](image-path-collisions.json)

## 结构计数与耗时

M / P 为 MinerU / PaddleOCR。块数不是准确率：一个公式可能拆成多块，表格也可能被归为代码或图像。

|编号|完整页数 M / P|公式块 M / P|表格块 M / P|Markdown tag 数 M / P|MinerU 成功尝试秒数|Paddle 服务端秒数|
|---|---:|---:|---:|---:|---:|---:|
'''
for s in stats:
    text+=f"|{s['id']}|{s['pages']} / {s['pages']}|{s['mineru_equations']} / {s['paddle_equations']}|{s['mineru_tables']} / {s['paddle_tables']}|{s['mineru_tags']} / {s['paddle_tags']}|{s['mineru_success_attempt_seconds']:.1f}|{s['paddle_server_seconds']:.0f}|\n"
text+=r'''
两列时间口径不同，**不能直接比较快慢**：MinerU 是工作台作业创建到完成，包含上传/轮询/下载；Paddle 是 API 的 `extractProgress.startTime/endTime`，不含本地完整下载。Paddle 的 05 返回 1 秒，只能当作服务端报告值，是否有缓存没有证据。此次并发度、网络重试也不同，不报告速度倍数或价格结论。

网络记录：MinerU 的 07 第一次 `ECONNRESET`，第二次成功；Paddle 的 Python requests TLS 链路多次断连，已按原 jobId 续取，后改用系统 curl 传输，保持证书校验。早期上传重试未回卷文件流，04 曾返回一次“文件格式不支持”；这是客户端重试实现问题，已修复，不能归因于模型。保留的 `run.json.previous_errors` 和 MinerU 作业账可追溯这些情况。没有保存每次中断前的精确完成时刻，因此不用总墙钟时间评价模型性能。

## 使用建议

1. **全文存档、公式交叉引用**：本批结果更支持保留 MinerU 作为现有默认链路，但不能因此跳过正文抽查。
2. **中文缩写、图号、英文行内数学符号有疑点时**：Paddle 可作为有效的第二份证据，08 的例子显示了实际收益。
3. **表格用于设计参数或计算时**：核对原页的行列结构和每个数值。两个引擎都生成“看起来完整”的 HTML，并不保证数据完整。
4. **若后续把 Paddle 接入论文库**：应从 JSON 保留页码、公式编号和关联位置；不能只照示例拼接 `markdown.text`。这一轮没有修改现有插件或论文库。

## 文件与复现

- `manifest.json`：10 篇的来源路径、标题、页数、输入副本 SHA-256、抽查页。
- `samples/NN/source.pdf`：原件副本；`page-NNN.png`：用于对照的原页渲染。
- `results/NN/mineru/full.md` 与 `images/`：MinerU 原始产物。`.mineru.pdf2md/` 留存云端 zip；`content_list.json` 从 zip 提取。
- `results/NN/paddle/`：submit/status 原回执、原始 JSONL、逐页 Markdown、全文、图像和布局标注。`pages/NNN/raw.md` 保留该页原始文本，根目录的逐页 Markdown 与全文仅改写图片相对路径。原始响应含有结果下载签名 URL，报告与页面没有嵌入这些远端链接。
- `compare.html`：离线三栏查看器，依赖同目录的 `vendor/`、`samples/`、`results/`；直接双击即可。浏览器预览服务仅绑定 127.0.0.1:18765。
- `inventory.py`、`prepare.py`：来源盘点与这次固定选样过程；已生成的 manifest 才是本次样本身份依据，不要依赖重新遍历目录的数组顺序重选样本。
- `run_paddle.py`：token 从 `PADDLEOCR_TOKEN` 环境变量读取；已完成样本跳过，已提交样本按 jobId 续取。Python `requests` 已安装，本次验证为 2.34.2；Windows TLS 传输使用 curl.exe，返回仍封装为 requests.Response。
- `analyze.py` → `validate.py` → `build_viewer.py` → `build_report.py`：重新整理统计、验证页数和图片、生成页面与报告。`differences.py` 只找差异线索，其相似度不是质量评分。

重新跑 MinerU 时，读 `mineru-jobs.json` / `mineru-status.json` 核对任务；新的输出用新目录，勿覆盖本轮证据。两平台的云端调用会使用对应账户配额。
'''
(root/'REPORT.md').write_text(text,encoding='utf-8')
(root/'report.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>论文 OCR 对比报告</title><style>body{max-width:1120px;margin:32px auto;padding:0 24px;color:#222;font:15px/1.8 "Microsoft YaHei",sans-serif}h1{font-size:28px}h2{font-size:22px;margin-top:36px}h3{font-size:18px}table{border-collapse:collapse;font-size:13px}td,th{border:1px solid #ccc;padding:8px}img{max-width:100%}code{font:13px Consolas,monospace;background:#f2f2f2}a{color:#23518d}</style>'+markdown.markdown(text,extensions=['tables','fenced_code'])+'</html>',encoding='utf-8')
print('Report written')
