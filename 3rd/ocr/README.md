# 3rd/ocr —— OCR 工具链（图片 / PDF → Markdown）

Prism 知识库扫描件的本地 OCR 入口：把**扫描版 PDF / 图片**识别成 Markdown 文本，
供 `packages/knowledge` 的转换层（`convert.ts` 的图片分支 / 扫描 PDF 分支）调用。

形态与 `3rd/graphify` 同模式：**Node 薄壳解析参数、spawn 一个独立 Python 主体**。

```
ocr_tool.mjs  (Node ESM 薄壳，解释器解析 + 参数转发)
     └── spawn ──> ocr_main.py  (Python 主体：pypdfium2 栅格化 + RapidOCR 识别
                                 + 可选 rapid_layout 版面 / rapid_table 表格)
                        ├── 核心三件套 ONNX（det/rec/cls，OCR 主路）
                        └── 可选两件 ONNX（slanet-plus 表格 / pp_doc_layoutv3 版面）
```

**本目录是独立工具，不 import 本仓任何 TS 代码**；`packages/**` 侧由后续批次接入。

## 用法

两个入口（一般只需用 Node 壳）：

```bash
# Node 薄壳（推荐）：--models 缺省 = 本目录 models/
node 3rd/ocr/ocr_tool.mjs <input> [--models <dir>] [--json] [--fake] \
                          [--table|--no-table] [--layout|--no-layout]

# Python 主体（薄壳其实就是去 spawn 它）
python 3rd/ocr/ocr_main.py <input> [--models <dir>] [--json] [--fake] \
                           [--table|--no-table] [--layout|--no-layout]
```

- `<input>`：PDF 或图片（`.png/.jpg/.jpeg/.bmp/.tif/.tiff/.webp/.gif` 按扩展名分流）。
- 默认输出 **Markdown**：每页一个小节 `## 第 N 页`，空行后接该页识别文本块；无文本写
  `（未检出文本）`。
- `--json`：输出单个 JSON（`ensure_ascii=False`，顶层带 `models_used`——本轮 layout/table
  实际推理次数）：

  ```json
  {"file":"a.pdf","total_pages":2,"models_used":{"table":0,"layout":2},
   "pages":[{"page":1,"blocks":8,"chars":214,"text":"…"},{"page":2,"blocks":0,"chars":0,"text":""}]}
  ```

- `--fake`：mock 推理层，不加载真实引擎 / 模型，供**无依赖、无模型**环境自测 stdout /
  JSON 结构（图片输出固定 mock 文本，含 `PRISM OCR MOCK`；PDF 仍需 `pypdfium2` 读页数）。
- `--table` / `--layout`（**缺省都开**，v17 B-A1）：分别开关表格还原与版面分析；
  `--no-table` / `--no-layout` 关掉。模型 / pip 包缺任一件即**静默跳过**该步。

工具**只负责识别**：不做「少文本跳过」判定（那是 Prism 侧守卫的事，见 v14 S3 谓词），
也不改写源文件。

## 版面分析 / 表格还原（v17 B-A1，可选增强）

在 OCR 主路之上，用两个**同族**判别模型做版面增强（**零 LLM、离线**）：

- **版面分析**（`rapid_layout` 的 `pp_doc_layoutv3`）：对整页出**区域**（类名 + 坐标）。
  区域类含 `text / table / display_formula / inline_formula / image / figure_title / …`。
- **阅读顺序**：按区域类与坐标重排——先跨栏区域、再**左栏整段、右栏整段**（多栏/双栏
  还原），区域内按 y→x。旧的「按 OCR 引擎自然序」在多栏页会左右交错。
- **表格还原**（`rapid_table` 的 `slanet-plus`）：只对 layout 判出的 **`table` 区域**
  裁图 → 结构识别 → **Markdown 管道表**（`| … |`，表头 + 分隔行 + 数据行）。
  **无 table 区域零 table 模型调用**（`models_used.table == 0` 可验）。

行为边界（SPEC-A1.2/A2.2/A2.3）：

- **单栏且无表格**的页 → 输出与「无 layout/table」**逐字一致**（回归锚；不做无谓重排）。
- 模型 / pip 包**未装**（缺文件或 `import` 失败）→ **静默跳过**，即回到**无 layout/table
  的旧输出**（不是「同现状」：装了 layout 后单栏也可能因重排而变，故未装时明确不启用）。
- 模型在但**加载/推理失败**（损坏）→ stderr **告警一行** + 跳过该步，**OCR 主路照常
  exit 0**。
- **公式占位**（v17 B-A2 / A-3）：layout 判出的 **`display_formula` 区域**（独立公式块）
  在阅读序里输出占位行 `[公式]`，该区域 OCR 出的散行**不进正文**（避免碎片混入）。
  **不做 LaTeX**（真还原记 D-v17-1）；`inline_formula`（行内片段）**刻意不处理**——它的
  矩形常落在某文本行中心，一并处理会把**整行**吞成占位。
  `--no-layout` 或未检出公式类 → 零行为变化；单栏且无表格的页**就地替换**、不重排其余行。

`packages/server` 侧由 `prism.yaml` 的**扁平键**控制（缺省都开）：`ocr_table` / `ocr_layout`
（认 `on/off`，非法值告警回落）。两键与两件模型**都就绪**才启用；否则转换层透传
`--no-table --no-layout`，逐字节回到旧输出。

## 文档内嵌图片（v17 B-A2 / A-4，`packages/knowledge/src/convert.ts`）

`toMarkdownBytes` 支持格式（**PDF 除外**——anydoc 对 PDF 无 `toDocument`）里，文档内嵌的
图片经 `toDocument` 取 `assets[].data` → 临时文件 → 同一 OCR 管道 → OCR 文本以
`> [图片 N] …` 引用块**插回原 alt 位置**（alt 整行被替换，位置不动）。

- **实测形态**：anydoc 的 Markdown 渲染器对**内嵌 asset 图**不写 `![alt](…)`，而是把
  **alt 当纯文本**内联（`src/render/markdown/inline.rs` 的 `ImageSource::Asset` 分支；
  alt 为空则**什么都不输出**）——故 Prism 侧的锚点只能是「alt 独占整行」。
- **mediaType 白名单**：`image/png` / `image/jpeg` / `image/webp`（与
  `OCR_IMAGE_EXTENSIONS` 同口径；`jpeg` 落 `.jpg`）。白名单外（bmp/gif/svg…）跳过。
- **失败语义**：OCR 未就绪 → **整条 assets 路径不走**（与 v14 逐字节回落契约零冲突）；
  单图失败 / 无有效文本 → 该图**保留原 alt 行**，整篇转换不失败。
- 临时文件落 `os.tmpdir()` 的独立 `mkdtemp` 目录，**用完必删**（R5）。
- 图片 OCR 文本**进 FTS 与段向量**（同正常文本口径）——它就是内容。

## 离线承诺

- **显式传模型路径**：`ocr_main.py` 把 `Det/Rec/Cls.model_path` 指向 `<models>/` 下的三件
  ONNX。rapidocr 缺省**首跑会自动联网**把模型拉到 `site-packages`，显式路径堵死该行为。
  表格 / 版面两件经 `rapid_table` / `rapid_layout` 也**一律显式传 `model_dir_or_path`**。
- **核心三件缺失即报错退出**（exit 2），**绝不回落联网**、不静默降级。
  可选两件缺失则**静默跳过**对应增强（见上节）。
- 模型文件名固定：

  | 角色 | 文件名 | 必备 |
  | :--- | :--- | :--- |
  | det | `ch_PP-OCRv5_det_server.onnx` | 是（核心） |
  | rec | `ch_PP-OCRv5_rec_server.onnx` | 是（核心） |
  | cls | `ch_PP-LCNet_x1_0_textline_ori_cls_server.onnx` | 是（核心） |
  | table | `slanet-plus.onnx` | 否（可选增强） |
  | layout | `pp_doc_layoutv3.onnx` | 否（可选增强） |

- ONNX 模型**内嵌字符表**（rapidocr 经 `session.get_character_list()` 读取），显式传
  `Rec.model_path` 时**无需**额外字典文件。
- **`ocr_version` 必须钉成 `PP-OCRv5`**：三件是 v5 **server** 权重，而 rapidocr 的默认档位是
  det/rec=`PP-OCRv6`、cls=`PP-OCRv4`。cls 的预处理输入尺寸**不看**配置里的 `cls_image_shape`
  （那是死值），而是查 `rapidocr/ch_ppocr_cls/main.py` 的 `CLS_SHAPE_BY_OCR_VERSION`：
  v4→`[3,48,192]`、v5→`[3,80,160]`。不钉就会把 `[3,48,192]` 的输入喂给要求 `[3,80,160]` 的
  server cls 模型，直接 `InvalidArgument: Got invalid dimensions`。
  ⚠ 该键是**枚举**参数（`ParseParams.update_batch` 校验），须传 `rapidocr.utils.typings.OCRVersion.PPOCRV5`，
  传字符串会被 `TypeError: … must be Enum Type` 拒掉。

## 安装

依赖与模型由 `scripts/setup-ocr.mjs` 安装（已随本仓提供，并挂在 `pnpm 3rd:setup` /
`pnpm 3rd:check` 上）：

```bash
pnpm run 3rd:setup           # anydoc + embedding + ocr 一次装好
node scripts/setup-ocr.mjs   # 只装 OCR；--check 看状态 / --force 重装 / --skip-* 细分跳过
```

脚本做三件事：

1. `python -m pip install -q -r 3rd/ocr/requirements.txt` —— Python 依赖
   （核心 `rapidocr==3.9.2` + `onnxruntime>=1.16` + `pypdfium2>=4`；可选
   `rapid_table==3.0.2` + `rapid_layout==1.2.1`；`Pillow` / `numpy<3` /
   `opencv_python` 随 `rapidocr` 传递安装）。已就绪则跳过；默认源失败会回落清华镜像。
   可选项装不上只告警，**不阻断**主路。
2. 逐件下载 ONNX 到 `3rd/ocr/models/`：核心三件（ModelScope `RapidAI/RapidOCR` tag
   `v3.9.2`）+ 可选两件（`RapidAI/RapidTable` 与 `RapidAI/RapidLayout` 的 master）。
   每件 `.part` → **字节数 + SHA256 校验** → 原子改名；已就绪则跳过，**可断点续传**。
   可选两件下载/校验失败只告警，**不阻断**主路。
3. **真识别自检**：用真模型跑 `fixtures/fixture-1-zh.png`，断言识别文本至少命中一个预期子串
   （比对前做空白归一；只要求「至少一个」是刻意宽松，OCR 质量随模型/平台波动）。

- `--check` 分列报告：核心 pip 依赖 / 可选 pip 依赖 / 五件模型各自状态 + `--fake` 自测。
  **退出码 0 只要求核心项**（核心依赖 + 核心三件 + 自测）——可选两件缺失不影响退出码，
  只提示「表格/版面增强不可用」（设计 A-0）。
- 模型目录 `3rd/ocr/models/`（核心约 179MB + 可选约 132MB）**不进 git**，`package.mjs`
  亦将显式排除（B-5）。
- pip 依赖**不随包**：解压环境要跑 OCR 需联网再跑一次 setup（同 graphify 口径）。
- 自检失败不静默：脚本以非零退出，并在 stderr 给出续传口径（重跑即跳过已校验通过的文件）。

## fixtures（测试样张）

`fixtures/` 下七张 **KB 级小图**由本地绘制生成，**全部进 git，无网络图片**：

| 文件 | 内容 | 有效字符 |
| :--- | :--- | :--- |
| `fixture-1-zh.png` | 中文多行 + 数字（Prism 知识库 OCR 样张…） | ≥50 |
| `fixture-2-en.png` | 纯英数多行（RapidOCR / pypdfium2 / onnxruntime） | ≥50 |
| `fixture-3-tiny.png` | 极短文本「小样张 PRISM」 | <50（供少文本守卫测试） |
| `fixture-4-table.png` | 单栏 + 带框线表格（v17 A1.1 / A1.3） | ≥50 |
| `fixture-5-two-col.png` | 标题 + 左右双栏（v17 A2.1） | ≥50 |
| `fixture-6-single-col.png` | 单栏（v17 A2.2 逐字回归锚） | ≥50 |
| `fixture-7-formula.png` | 单栏 + 大字号居中独立公式块 `E = mc2`（v17 A3.1） | ≥50 |

另有 **docx 内嵌图 fixture**（`gen_docx_fixtures.py`，纯 stdlib 拼最小 OOXML）：

| 文件 | 内容 |
| :--- | :--- |
| `embed-image.docx` | 正文 + 独立图片段落（alt 中文说明，媒体 `image/png`）——A4.1 正路 |
| `embed-nonwhitelist.docx` | 同上但媒体 `image/bmp`——A4.1「白名单外跳过」分支 |

有效字符口径（与 v14 设计一致）：**CJK 计 1 + `[A-Za-z0-9]` 计 1；空白/标点计 0**。
`fixtures/expected.json` 记录每张图的预期子串、`kind` 与 `valid_chars`。

> 版面/表格/公式四张是**真模型断言**的输入（`test_layout_table.py`）。layout 模型对文本
> 密度与字号敏感——双栏样张的栏宽/行数/字号、公式样张的**字号 ≥96 且居中 + 上下留白**
> 均经实测选定（公式页 64px 或混排 `y = ax2 + bx + c` **检不出**）；若改样张，须重跑
> `test_layout_table.py` 确认仍能稳定检出两栏 / table / `display_formula`。

重新生成（可重复执行、覆盖输出；字体按平台候选列表探测，可用 `PRISM_OCR_FONT` 覆盖）：

```bash
python -m pip install pillow
python 3rd/ocr/gen_fixtures.py         # PNG 样张 + expected.json
python 3rd/ocr/gen_docx_fixtures.py    # 内嵌图 docx（纯 stdlib，无新依赖）
```

## 自测

无依赖自测（**stdlib-only**，不 import rapidocr/pypdfium2，跑 `--fake` 与用法守卫）——
`scripts/setup-ocr.mjs --check` 用的就是它，必须秒级完成：

```bash
python 3rd/ocr/test_smoke.py     # 打印 PASS / FAIL，失败非零退出
```

真模型自测（v17 A1/A2；需核心三件 + 可选两件模型与对应 pip 包，**缺件则 SKIP 且 exit 0**）：

```bash
python 3rd/ocr/test_layout_table.py   # A1.1 表格还原 / A1.3 零调用 / A2.1 双栏序 / A2.2 单栏逐字
```

真机冒烟（需先装依赖与模型，见安装章节）：

```bash
python 3rd/ocr/ocr_main.py 3rd/ocr/fixtures/fixture-1-zh.png --models 3rd/ocr/models
python 3rd/ocr/ocr_main.py 3rd/ocr/fixtures/fixture-4-table.png --models 3rd/ocr/models --json
```

## 退出码

| 码 | 含义 |
| :--- | :--- |
| 0 | 成功 |
| 1 | 意外运行时错误；Node 壳另用于「解释器无法启动」（ENOENT 等） |
| 2 | 用法错误 / 输入不存在 / **核心**模型缺失 / pip 依赖缺失 / `--fake` 处理 PDF 缺 pypdfium2 |

> 可选两件（表格/版面）缺失**不**置 2——它们只是跳过增强（见「版面分析 / 表格还原」节）。

## 解释器镜像契约（M6 三件套 · 第三处）

`ocr_tool.mjs` 的 Python 解释器解析**刻意镜像**：

1. `scripts/python.mjs`（`resolvePython`）—— 发行代码的**规范源**（`scripts/` 不进发行包，
   TS 侧无法导入，镜像不可免）；
2. `packages/server/src/graph/graphify.ts`（`resolvePythonCommand`）；
3. **本工具** `3rd/ocr/ocr_tool.mjs`（`resolvePython`）—— 第三处。

三处保持同构：`IS_WINDOWS` / `SUFFIXES = IS_WINDOWS ? ['.exe',''] : ['']` /
`ORDER = IS_WINDOWS ? ['python','python3'] : ['python3','python']` 三个常量形状一致、
`PRISM_PYTHON` 环境变量覆盖、PATH 上按 `X_OK` 探测、探不到回落平台惯例名。

> **改一处必须同步另两处**，并同步 `doc/requirements/cross-platform.md` §3「唯一真相源」
> 的 Python 行与 `AGENTS.md` 陷阱表。有测试读这三处文本做同构断言防漂移。

## 给消费方（`packages/knowledge/src/convert.ts`）的 CLI 契约

- **stdout 只放结果**：默认 Markdown（`## 第 N 页` 分节）；`--json` 时是单个 JSON。
  不掺任何日志、进度、警告行。
- **诊断/日志一律走 stderr**（Windows 控制台默认 GBK，stdout 入口已 reconfigure 为 UTF-8；
  薄壳另给子进程注入 `PYTHONIOENCODING=utf-8`）。
- **退出码**即错误分类（见上表）：`2` 可视为「未安装 / 未就绪」，据此把 `needsOcr`
  维持为现状错误文案（逐字回落）；`0` 才解析 stdout。
- 输入 / 输出路径与编码不做隐式猜测：输入路径由调用方给绝对路径（薄壳会 `resolve`）。
