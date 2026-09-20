# 3rd/ocr —— OCR 工具链（图片 / PDF → Markdown）

Prism 知识库扫描件的本地 OCR 入口：把**扫描版 PDF / 图片**识别成 Markdown 文本，
供 `packages/knowledge` 的转换层（`convert.ts` 的图片分支 / 扫描 PDF 分支）调用。

形态与 `3rd/graphify` 同模式：**Node 薄壳解析参数、spawn 一个独立 Python 主体**。

```
ocr_tool.mjs  (Node ESM 薄壳，解释器解析 + 参数转发)
     └── spawn ──> ocr_main.py  (Python 主体：pypdfium2 栅格化 + RapidOCR 识别)
                        └── 三件套 ONNX（models/，由 setup-ocr.mjs 落盘）
```

**本目录是独立工具，不 import 本仓任何 TS 代码**；`packages/**` 侧由后续批次接入。

## 用法

两个入口（一般只需用 Node 壳）：

```bash
# Node 薄壳（推荐）：--models 缺省 = 本目录 models/
node 3rd/ocr/ocr_tool.mjs <input> [--models <dir>] [--json] [--fake]

# Python 主体（薄壳其实就是去 spawn 它）
python 3rd/ocr/ocr_main.py <input> [--models <dir>] [--json] [--fake]
```

- `<input>`：PDF 或图片（`.png/.jpg/.jpeg/.bmp/.tif/.tiff/.webp/.gif` 按扩展名分流）。
- 默认输出 **Markdown**：每页一个小节 `## 第 N 页`，空行后接该页识别文本块；无文本写
  `（未检出文本）`。
- `--json`：输出单个 JSON（`ensure_ascii=False`）：

  ```json
  {"file":"a.pdf","total_pages":2,
   "pages":[{"page":1,"blocks":8,"chars":214,"text":"…"},{"page":2,"blocks":0,"chars":0,"text":""}]}
  ```

- `--fake`：mock 推理层，不加载真实引擎 / 模型，供**无依赖、无模型**环境自测 stdout /
  JSON 结构（图片输出固定 mock 文本，含 `PRISM OCR MOCK`；PDF 仍需 `pypdfium2` 读页数）。

工具**只负责识别**：不做「少文本跳过」判定（那是 Prism 侧守卫的事，见 v14 S3 谓词），
也不改写源文件。

## 离线承诺

- **显式传模型路径**：`ocr_main.py` 把 `Det/Rec/Cls.model_path` 指向 `<models>/` 下的三件
  ONNX。rapidocr 缺省**首跑会自动联网**把模型拉到 `site-packages`，显式路径堵死该行为。
- **模型缺失即报错退出**（exit 2），**绝不回落联网**、不静默降级。
- 模型文件名固定（PP-OCRv5 server）：

  | 角色 | 文件名 |
  | :--- | :--- |
  | det | `ch_PP-OCRv5_det_server.onnx` |
  | rec | `ch_PP-OCRv5_rec_server.onnx` |
  | cls | `ch_PP-LCNet_x1_0_textline_ori_cls_server.onnx` |

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
   （`rapidocr==3.9.2` + `onnxruntime>=1.16` + `pypdfium2>=4`；`Pillow` / `numpy<3` /
   `opencv_python` 随 `rapidocr` 传递安装）。已就绪则跳过；默认源失败会回落清华镜像。
2. 逐件下载三件 ONNX（ModelScope `RapidAI/RapidOCR`，tag `v3.9.2`）到 `3rd/ocr/models/`：
   `.part` → **字节数 + SHA256 校验** → 原子改名；已就绪则跳过，**可断点续传**。
3. **真识别自检**：用真模型跑 `fixtures/fixture-1-zh.png`，断言识别文本至少命中一个预期子串
   （比对前做空白归一；只要求「至少一个」是刻意宽松，OCR 质量随模型/平台波动）。

- 模型目录 `3rd/ocr/models/`（约 179MB）**不进 git**，`package.mjs` 亦将显式排除（B-5）。
- pip 依赖**不随包**：解压环境要跑 OCR 需联网再跑一次 setup（同 graphify 口径）。
- 自检失败不静默：脚本以非零退出，并在 stderr 给出续传口径（重跑即跳过已校验通过的文件）。

## fixtures（测试样张）

`fixtures/` 下三张 **KB 级小图**由本地绘制生成，**全部进 git，无网络图片**：

| 文件 | 内容 | 有效字符 |
| :--- | :--- | :--- |
| `fixture-1-zh.png` | 中文多行 + 数字（Prism 知识库 OCR 样张…） | ≥50 |
| `fixture-2-en.png` | 纯英数多行（RapidOCR / pypdfium2 / onnxruntime） | ≥50 |
| `fixture-3-tiny.png` | 极短文本「小样张 PRISM」 | <50（供少文本守卫测试） |

有效字符口径（与 v14 设计一致）：**CJK 计 1 + `[A-Za-z0-9]` 计 1；空白/标点计 0**。
`fixtures/expected.json` 记录每张图的预期子串与 `valid_chars`。

重新生成（可重复执行、覆盖输出；字体按平台候选列表探测，可用 `PRISM_OCR_FONT` 覆盖）：

```bash
python -m pip install pillow
python 3rd/ocr/gen_fixtures.py
```

## 自测

无依赖自测（**stdlib-only**，不 import rapidocr/pypdfium2，跑 `--fake` 与用法守卫）：

```bash
python 3rd/ocr/test_smoke.py     # 打印 PASS / FAIL，失败非零退出
```

真机冒烟（需先装依赖与模型，见安装章节）：

```bash
python 3rd/ocr/ocr_main.py 3rd/ocr/fixtures/fixture-1-zh.png --models 3rd/ocr/models
```

## 退出码

| 码 | 含义 |
| :--- | :--- |
| 0 | 成功 |
| 1 | 意外运行时错误；Node 壳另用于「解释器无法启动」（ENOENT 等） |
| 2 | 用法错误 / 输入不存在 / 模型缺失 / pip 依赖缺失 / `--fake` 处理 PDF 缺 pypdfium2 |

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
