# MinerU 与 PaddleOCR-VL-1.6：10 篇论文、194 页的识别对比

复现：在放着样本的目录里依次运行 `inventory.py`、`prepare.py`（选样，生成 `manifest.json` 与 `samples/`），MinerU 一侧用工作台 `pdf2md.submit` 提交每篇 `samples/NN/source.pdf`，
Paddle 一侧设好环境变量 `PADDLEOCR_TOKEN` 后运行 `run_paddle.py`，最后 `analyze.py` → `validate.py` → `build_viewer.py` → `build_report.py`。依赖版本见 `environment.json`。

结论与逐条差异见 `REPORT.md`：MinerU 的公式编号保留得完整，继续当默认；Paddle 适合在中文缩写、图号、英文行内公式有疑点的页上做第二份对照；两个引擎的表格都要逐个数值核对。

| 文件 | 内容 |
| --- | --- |
| `REPORT.md` | 实验报告 |
| `metrics.json` | 每篇的页数、公式块、表格块、`\tag` 计数与耗时 |
| `validation.json` | 页数与图片落盘的机器校验结果 |
| `image-path-collisions.json` | Paddle 示例写法下跨页重名的图片路径 |
| `*.py` | 选样、调用 Paddle、统计、校验、生成对照页与报告的脚本 |

原始证据没有进 git，留在本机单元 `D:\unitfolders\xc738-paper-ocr-benchmark\`：论文 PDF 副本与原页渲染图（`samples/`，有版权）、两个引擎的原始产物（`results/`，Paddle 的原始回执带结果下载的签名地址）、
离线三栏对照页 `compare.html` 及其 `vendor/`、带本机路径与原文摘录的 `manifest.json`、原文差异线索 `differences.txt`、MinerU 作业账 `mineru-jobs.json` / `mineru-status.json`。
`REPORT.md` 里指向这些文件的链接在那个目录里才打得开。
