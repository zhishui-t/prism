#!/usr/bin/env python3
"""Prism OCR 工具主体（3rd/ocr）：图片 / PDF → Markdown 文本。

用法（一般由同目录的 ocr_tool.mjs 薄壳调用）::

    python ocr_main.py <input> [--models <dir>] [--json] [--fake]
                       [--table|--no-table] [--layout|--no-layout]

真实模式
    用 pypdfium2 把 PDF 按 300 DPI 栅格化（图片直接 PIL 打开转 RGB），逐页交给
    RapidOCR（onnxruntime 后端）识别，cls 方向分类由引擎内部完成。**显式传
    Det/Rec/Cls 三件模型路径**——rapidocr 缺省首跑会自动联网把模型拉到
    site-packages，显式路径堵死该行为；模型缺失即报错退出，**绝不回落联网**。
    三件都是 PP-OCRv5 **server** 权重，故还须把 `ocr_version` 钉成 PP-OCRv5
    （cls 的预处理尺寸由它决定，默认 PP-OCRv4 会形状不符直接报错，详见 build_engine）。

版面 / 表格增强（v17 B-A1，可选）
    `--layout`（缺省开）用 `rapid_layout` 的 `pp_doc_layoutv3` 做版面分析，按区域类
    与坐标还原阅读顺序（多栏/双栏）；`--table`（缺省开）用 `rapid_table` 的
    `slanet-plus` 识别 layout 判出的 **table 区域**，产出 Markdown 管道表。两件模型
    与两个 pip 包都**显式路径、绝不联网**。任一未装（缺文件 / 缺包）→ **静默跳过**，
    即回到「无 layout/table 的旧输出」（不是「同现状」：装了 layout 后单栏也可能因
    阅读顺序重排而变，故未装时明确不启用）；模型在但加载/推理失败 → stderr 告警一行
    并跳过该步，**OCR 主路照常 exit 0**。单栏且无表格的页**逐字保持旧输出**（回归锚）。

公式占位（v17 B-A3，随 layout）
    layout 判出的 **display_formula 区域**（独立公式块）在阅读序里输出占位行
    ``[公式]``，该区域内 OCR 出的散行文本**不进正文**（避免碎片混入；不做 LaTeX，
    真还原记 D-v17-1）。`--no-layout` → 零行为变化；未检出公式类的页也零行为变化。
    单栏且无表格的页走「就地替换」（不重排其余行）；多栏/含表的页在区域装配里出占位。

--fake
    mock 推理层：不 import 真引擎（PDF 读页数仍需 pypdfium2），供无依赖、无模型的机器
    自测 stdout / JSON 结构（含 `models_used`，恒为 0）。图片输出固定 mock 文本。

输出约定（给消费方 packages/knowledge/src/convert.ts）
    stdout 只放结果：默认 Markdown（每页一个小节 ``## 第 N 页``），``--json`` 时放单个
    JSON（``ensure_ascii=False``，含顶层 ``models_used``——本轮 layout/table 实际推理
    次数，A1.3 观测点）。**一切诊断/日志走 stderr**（Windows 控制台 GBK 陷阱）。
    少文本跳过判定**不在这里做**——那是 Prism 侧的守卫，本工具只负责识别。

退出码
    0 成功；1 意外运行时错误；2 用法错误 / 输入不存在 / 核心模型缺失 / pip 依赖缺失。

本文件为独立 Python 工具，不依赖本仓任何 TS 代码。解释器解析的镜像契约见
同目录 ocr_tool.mjs（M6 三件套：scripts/python.mjs 规范源 + graphify.ts + 本工具）。
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from html.parser import HTMLParser
from pathlib import Path

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

EXIT_OK = 0
EXIT_RUNTIME = 1
EXIT_USAGE = 2

# 核心三件套 ONNX 的固定文件名（PP-OCRv5 server，由 scripts/setup-ocr.mjs 落到
# <models>/；见 3rd/ocr/requirements.txt 与 README.md）。
MODEL_FILES = {
    "det": "ch_PP-OCRv5_det_server.onnx",
    "rec": "ch_PP-OCRv5_rec_server.onnx",
    "cls": "ch_PP-LCNet_x1_0_textline_ori_cls_server.onnx",
}

# 可选两件（v17 B-A1）。文件名与 `scripts/setup-ocr.mjs` 的 MODELS 表**镜像**
# （跨语言无法共享常量，改动必须两处同步；setup-ocr.mjs --check 会逐件校验 SHA256）。
TABLE_MODEL_FILE = "slanet-plus.onnx"
TABLE_MODEL_TYPE = "slanet_plus"
LAYOUT_MODEL_FILE = "pp_doc_layoutv3.onnx"
LAYOUT_MODEL_TYPE = "pp_doc_layoutv3"

# layout 区域类（pp_doc_layoutv3 实测 25 类里我们消费的两个）：表格 / 公式。
# 公式**只认 display_formula**（独立公式块，A-3）：inline_formula 是行内片段，其矩形
# 往往落在某文本行的中心，若一并处理会把**整行**文本吞成一个占位（得不偿失）。
TABLE_LABEL = "table"
FORMULA_LABEL = "display_formula"
# 公式区域的占位行（占位文本本身进 FTS/段向量——口径见 spec-v17 SPEC-A3.1）。
FORMULA_PLACEHOLDER = "[公式]"

# PDF 栅格化比例：300 DPI / PDF 默认 72 DPI。
RENDER_SCALE = 300 / 72

IMAGE_EXTENSIONS = frozenset(
    {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp", ".gif"}
)

MOCK_LINES = ("PRISM OCR MOCK", "（--fake 模式：未调用真实 OCR 引擎，仅用于结构自测）")


# ---------------------------------------------------------------------------
# 基础设施
# ---------------------------------------------------------------------------


def reconfigure_streams() -> None:
    """把 stdout/stderr 切到 UTF-8（Windows 控制台默认 GBK，中文会炸或乱码）。

    stdout 是硬要求；stderr 一并对齐，保证被父进程按 UTF-8 捕获时诊断文本一致。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError, OSError):
            # 极少数宿主（pythonw 等）没有真实流；退化为默认编码即可。
            pass


def warn(message: str) -> None:
    sys.stderr.write(f"[ocr] {message}\n")


def die(message: str, code: int) -> "None":
    warn(message)
    raise SystemExit(code)


def default_models_dir() -> Path:
    return Path(__file__).resolve().parent / "models"


def module_available(name: str) -> bool:
    """pip 包是否可导入（缺包即视为该步不可用）。"""
    try:
        importlib.import_module(name)
    except Exception:  # noqa: BLE001 — 缺包/损坏包都算不可用
        return False
    return True


# ---------------------------------------------------------------------------
# 输入分流与模型检查
# ---------------------------------------------------------------------------


def classify_input(path: Path) -> str:
    """按扩展名分流：'pdf' / 'image'；其余报用法错误退出。"""
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return "pdf"
    if suffix in IMAGE_EXTENSIONS:
        return "image"
    die(
        f"不支持的输入类型「{path.name}」（扩展名 {suffix or '（无）'}）——"
        f"仅支持 PDF 与图片（{'/'.join(sorted(IMAGE_EXTENSIONS))}）",
        EXIT_USAGE,
    )
    raise AssertionError("unreachable")  # pragma: no cover


def require_models(models_dir: Path) -> dict:
    """检查核心三件 ONNX 是否齐备；缺失即中文报错 + 退出 2（不联网兜底）。"""
    missing = [name for name in MODEL_FILES.values() if not (models_dir / name).is_file()]
    if missing:
        warn(f"OCR 模型缺失（{len(missing)}/3）：{'、'.join(missing)}")
        warn(f"期望模型目录：{models_dir}")
        warn("请先运行  node scripts/setup-ocr.mjs  下载 PP-OCRv5 server 三件套 ONNX。")
        warn("（本工具使用显式模型路径，绝不会联网自动拉取模型。）")
        raise SystemExit(EXIT_USAGE)
    return {key: models_dir / name for key, name in MODEL_FILES.items()}


# ---------------------------------------------------------------------------
# 识别结果组装
# ---------------------------------------------------------------------------


def page_from_lines(lines) -> dict:
    """把一页的文本块（按行）整理成统计 + 文本。"""
    kept = [line for line in lines if isinstance(line, str) and line != ""]
    return {
        "blocks": len(kept),
        "chars": sum(len(line) for line in kept),
        "text": "\n".join(kept),
    }


def _poly_bbox(poly) -> tuple:
    """四边形/矩形 → (x0, y0, x1, y1, cx, cy)。"""
    xs = [float(point[0]) for point in poly]
    ys = [float(point[1]) for point in poly]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    return x0, y0, x1, y1, (x0 + x1) / 2, (y0 + y1) / 2


def recognize(engine, array) -> dict:
    """跑一次引擎，取 result 的 boxes/txts/scores → 页结果（含逐行几何）。

    boxes 必须保留：layout 区域归属（阅读顺序）与 table 区域裁图的 OCR 复用都靠它
    （v17 B-A1 BLOCKER 修订——旧实现只取 txts，boxes 被丢弃）。
    """
    result = engine(array)
    txts = getattr(result, "txts", None)
    boxes = getattr(result, "boxes", None)
    scores = getattr(result, "scores", None)
    lines = []
    if boxes is not None and txts is not None:
        for index, text in enumerate(txts):
            poly = boxes[index]
            x0, y0, x1, y1, cx, cy = _poly_bbox(poly)
            lines.append(
                {
                    "text": text,
                    "x0": x0,
                    "y0": y0,
                    "x1": x1,
                    "y1": y1,
                    "cx": cx,
                    "cy": cy,
                    "score": float(scores[index]) if scores is not None else 1.0,
                    "poly": [[float(p[0]), float(p[1])] for p in poly],
                }
            )
    page = page_from_lines(txts if txts is not None else ())
    page["lines"] = lines
    return page


# ---------------------------------------------------------------------------
# 版面分析（v17 A-2）与表格还原（v17 A-1）
# ---------------------------------------------------------------------------


def layout_ready(models_dir: Path) -> bool:
    """版面模型是否可用：文件在 + `rapid_layout` 可导入（缺任一 → 静默跳过）。"""
    return (models_dir / LAYOUT_MODEL_FILE).is_file() and module_available("rapid_layout")


def table_ready(models_dir: Path) -> bool:
    """表格模型是否可用：文件在 + `rapid_table` 可导入（缺任一 → 静默跳过）。"""
    return (models_dir / TABLE_MODEL_FILE).is_file() and module_available("rapid_table")


def build_layout_engine(models_dir: Path):
    """构造版面引擎（显式路径 = 离线承诺）。"""
    from rapid_layout import RapidLayout  # noqa: PLC0415 — 延迟 import（无依赖环境不炸）

    return RapidLayout(
        model_type=LAYOUT_MODEL_TYPE,
        model_dir_or_path=str(models_dir / LAYOUT_MODEL_FILE),
    )


def build_table_engine(models_dir: Path, ocr_params: dict):
    """构造表格引擎（显式路径；内部 OCR 也用显式参数——我们随后会传入自己的结果）。

    `use_ocr=True` 是拿到 `pred_htmls` 的必要条件；实际推理时传入**本页 OCR 的结果**
    （裁图坐标），故不会二次跑 OCR。内部 OCR 引擎仍需构造（包 API 无「只跑结构」的口），
    一并给显式参数以免缺省参数触发联网拉模型。
    """
    from rapid_table import RapidTable  # noqa: PLC0415
    from rapid_table.utils import ModelType, RapidTableInput  # noqa: PLC0415

    cfg = RapidTableInput(
        model_type=ModelType.SLANETPLUS,
        model_dir_or_path=str(models_dir / TABLE_MODEL_FILE),
        use_ocr=True,
        ocr_params=ocr_params,
    )
    return RapidTable(cfg)


def run_layout(engine, array) -> list:
    """跑版面模型 → 区域列表（矩形 + 类名 + 置信度）。"""
    out = engine(array)
    boxes = getattr(out, "boxes", None) or []
    names = getattr(out, "class_names", None) or []
    scores = getattr(out, "scores", None) or []
    regions = []
    for index, box in enumerate(boxes):
        values = [float(v) for v in box]
        if len(values) < 4:  # 防御：期望 [x0,y0,x1,y1]
            continue
        x0, y0, x1, y1 = values[0], values[1], values[2], values[3]
        regions.append(
            {
                "box": [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)],
                "cls": str(names[index]) if index < len(names) else "",
                "score": float(scores[index]) if index < len(scores) else 1.0,
            }
        )
    return regions


def _column_of(region: dict, middle: float) -> int:
    """区域分栏：0=跨栏，1=左栏，2=右栏（按矩形与页面中线的关系）。"""
    x0, _, x1, _ = region["box"]
    if x0 >= middle:
        return 2
    if x1 <= middle:
        return 1
    return 0


def order_regions(regions: list, page_width: float) -> tuple:
    """把区域排成阅读顺序，并报告是否检测到多栏。

    做法（够用且可解释）：
    1. 按页面中线把区域分成左/右/跨栏三组；
    2. 左、右**都有**且纵向范围有重叠 → 判为多栏（A2.1）；
    3. 按 y 切「带」（纵向重叠的区域归一带），带内先跨栏、再左栏、再右栏（各按 y、x）。
    单栏（无多栏且无表格）的页**不走这里**——调用方直接回退旧输出（A2.2 回归锚）。
    """
    middle = page_width / 2
    columns = [_column_of(r, middle) for r in regions]
    has_left = 1 in columns
    has_right = 2 in columns
    multi_column = False
    if has_left and has_right:
        left = [r for r, c in zip(regions, columns) if c == 1]
        right = [r for r, c in zip(regions, columns) if c == 2]
        ly0 = min(r["box"][1] for r in left)
        ly1 = max(r["box"][3] for r in left)
        ry0 = min(r["box"][1] for r in right)
        ry1 = max(r["box"][3] for r in right)
        multi_column = min(ly1, ry1) - max(ly0, ry0) > 0

    bands: list = []
    for region, column in sorted(zip(regions, columns), key=lambda p: (p[0]["box"][1], p[0]["box"][0])):
        for band in bands:
            if region["box"][1] < band["y1"]:  # 与当前带纵向重叠 → 并入
                band["items"].append((region, column))
                band["y1"] = max(band["y1"], region["box"][3])
                break
        else:
            bands.append({"items": [(region, column)], "y1": region["box"][3]})

    ordered = []
    for band in bands:
        for region, _ in sorted(band["items"], key=lambda p: (p[1], p[0]["box"][1], p[0]["box"][0])):
            ordered.append(region)
    return ordered, multi_column


def assign_lines(lines: list, regions: list) -> tuple:
    """把 OCR 行按**中心点包含**归到区域；落不进任何区域的行单独收集（不丢）。"""
    buckets: list = [[] for _ in regions]
    leftover: list = []
    for line in lines:
        cx, cy = line["cx"], line["cy"]
        best = None
        for index, region in enumerate(regions):
            x0, y0, x1, y1 = region["box"]
            if x0 <= cx <= x1 and y0 <= cy <= y1:
                area = (x1 - x0) * (y1 - y0)
                if best is None or area < best[0]:
                    best = (area, index)
        if best is None:
            leftover.append(line)
        else:
            buckets[best[1]].append(line)
    return buckets, leftover


def line_in_region(line: dict, region: dict) -> bool:
    """行中心点是否落在区域矩形内（与 {@link assign_lines} 同一判据）。"""
    x0, y0, x1, y1 = region["box"]
    return x0 <= line["cx"] <= x1 and y0 <= line["cy"] <= y1


def page_with_formula_placeholders(page: dict, formula_regions: list) -> dict:
    """单栏页：把公式区域内的散行**就地**换成 `[公式]`；其余行序不动（A-3）。

    单栏文档不该因「有公式」而被重排阅读顺序（A2.2 的锚定原则）——故这条路径
    **不**走区域装配，只在原有行序里做替换：落在 display_formula 矩形内的行丢弃，
    该区域在**它的纵向位置**上留下一个占位行（空区域也出占位——layout 说有公式）。
    行与占位统一按 (y, x) 排序，等价于单栏的阅读顺序。
    """
    items = [
        (line["y0"], line["x0"], line["text"])
        for line in page["lines"]
        if not any(line_in_region(line, region) for region in formula_regions)
    ]
    for region in formula_regions:
        items.append((region["box"][1], region["box"][0], FORMULA_PLACEHOLDER))
    items.sort(key=lambda item: (item[0], item[1]))

    enhanced = page_from_lines([item[2] for item in items])
    enhanced["lines"] = page["lines"]
    return enhanced


class _TableParser(HTMLParser):
    """把 rapid_table 的 HTML 表拆成二维单元格文本（忽略标签属性/嵌套行内标签）。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list = []
        self._row = None
        self._cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th"):
            if self._row is None:
                self._row = []
            self._cell = []

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag):
        if tag in ("td", "th"):
            if self._row is not None:
                text = "".join(self._cell or []).strip()
                text = text.replace("|", "\\|").replace("\n", " ")
                self._row.append(text)
            self._cell = None
        elif tag == "tr":
            if self._row is not None:
                self.rows.append(self._row)
            self._row = None

    def close(self):  # noqa: D102 — 收尾时把未闭合的行也算上
        super().close()
        if self._row:
            self.rows.append(self._row)
            self._row = None


def html_table_to_markdown(html: str) -> str:
    """HTML 表 → Markdown 管道表（表头 + 分隔行 + 数据行）。

    少于两列的「表」不认（SPEC-A1.1 要求 `|` 且 ≥2 列）；无 `<td>` 时返回空串，
    调用方据此回退该区域的纯文本。
    """
    if not html or "<td" not in html.lower():
        return ""
    parser = _TableParser()
    parser.feed(html)
    parser.close()
    rows = [row for row in parser.rows if row]
    if not rows:
        return ""
    columns = max(len(row) for row in rows)
    if columns < 2:
        return ""

    def render(cells) -> str:
        padded = list(cells) + [""] * (columns - len(cells))
        return "| " + " | ".join(padded) + " |"

    out = [render(rows[0]), "| " + " | ".join(["---"] * columns) + " |"]
    out.extend(render(row) for row in rows[1:])
    return "\n".join(out)


def table_region_markdown(array, region: dict, lines: list, table_engine, np) -> str:
    """裁 table 区域 → rapid_table（复用本页 OCR 结果）→ Markdown 表；不可用返回 ''。"""
    height, width = array.shape[0], array.shape[1]
    x0, y0, x1, y1 = (int(round(v)) for v in region["box"])
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(width, x1), min(height, y1)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return ""
    crop = array[y0:y1, x0:x1]
    boxes, txts, scores = [], [], []
    for line in lines:
        poly = np.array(line["poly"], dtype="float32")
        poly[:, 0] -= x0
        poly[:, 1] -= y0
        boxes.append(poly)
        txts.append(line["text"])
        scores.append(line["score"])
    if not boxes:
        return ""
    result = table_engine(
        crop, ocr_results=[(np.array(boxes), tuple(txts), np.array(scores))]
    )
    htmls = getattr(result, "pred_htmls", None) or []
    if not htmls:
        return ""
    return html_table_to_markdown(htmls[0])


def process_page(engine, array, ctx: dict, opts: dict, models_used: dict) -> dict:
    """单页：OCR 主路 +（可选）版面阅读顺序 + 公式占位 + 表格还原。"""
    page = recognize(engine, array)

    # 未启用 / 版面模型未装 → 静默回到旧输出（SPEC-A1.2/A2.3）
    if not opts["layout"] or ctx["layout_engine"] is None:
        return page
    try:
        regions = run_layout(ctx["layout_engine"], array)
        models_used["layout"] += 1
    except Exception as exc:  # noqa: BLE001 — 模型在但坏了：告警 + 跳过该步，主路照常
        warn(f"版面分析失败，已跳过该步（OCR 主路照常）：{type(exc).__name__}: {exc}")
        return page

    table_regions = [r for r in regions if r["cls"] == TABLE_LABEL]
    formula_regions = [r for r in regions if r["cls"] == FORMULA_LABEL]
    ordered, multi_column = order_regions(regions, float(array.shape[1]))
    if not table_regions and not multi_column and not formula_regions:
        # 单栏、无表格、无公式：**逐字保持旧输出**（SPEC-A2.2 回归锚）
        return page
    if not table_regions and not multi_column:
        # 单栏 + 公式：就地替换散行，不重排阅读顺序（A-3）
        return page_with_formula_placeholders(page, formula_regions)

    buckets, leftover = assign_lines(page["lines"], ordered)
    blocks: list = []
    for index, region in enumerate(ordered):
        region_lines = buckets[index]
        if region["cls"] == FORMULA_LABEL:
            # 公式区域：散行不进正文，只留占位（A-3）
            blocks.append(FORMULA_PLACEHOLDER)
            continue
        if region["cls"] == TABLE_LABEL and opts["table"] and ctx["has_table"]:
            markdown = ""
            try:
                table_engine = ctx["get_table_engine"]()
                markdown = table_region_markdown(array, region, region_lines, table_engine, ctx["np"])
                if markdown != "":
                    models_used["table"] += 1
            except Exception as exc:  # noqa: BLE001 — 同上：告警 + 跳过该步
                warn(f"表格识别失败，已按纯文本跳过该区域：{type(exc).__name__}: {exc}")
                markdown = ""
            if markdown != "":
                blocks.append(markdown)
                continue
        text = "\n".join(line["text"] for line in _sort_lines(region_lines))
        if text != "":
            blocks.append(text)

    if leftover:
        text = "\n".join(line["text"] for line in _sort_lines(leftover))
        if text != "":
            blocks.append(text)

    enhanced = page_from_lines(blocks)
    enhanced["lines"] = page["lines"]
    return enhanced


def _sort_lines(lines: list) -> list:
    """区域内按阅读顺序排：先上后下（y），再左后右（x）。"""
    return sorted(lines, key=lambda line: (line["y0"], line["x0"]))


# ---------------------------------------------------------------------------
# 真实模式
# ---------------------------------------------------------------------------


def load_real_dependencies(need_pdf: bool):
    """延迟 import 重依赖；缺依赖给可读报错 + 退出 2。"""
    try:
        import numpy as np  # noqa: PLC0415 — 延迟 import，避免无依赖环境启动即炸
        from PIL import Image  # noqa: PLC0415
        from rapidocr import RapidOCR  # noqa: PLC0415
        from rapidocr.utils.typings import OCRVersion  # noqa: PLC0415
    except ImportError as exc:
        warn(f"缺少 Python 依赖：{exc}")
        warn("请先运行  node scripts/setup-ocr.mjs  安装（rapidocr / onnxruntime / pypdfium2 / Pillow）。")
        raise SystemExit(EXIT_USAGE) from exc

    pdfium = None
    if need_pdf:
        try:
            import pypdfium2 as pdfium  # noqa: PLC0415
        except ImportError as exc:
            warn(f"处理 PDF 需要 pypdfium2，但导入失败：{exc}")
            warn("请先运行  node scripts/setup-ocr.mjs  安装 pypdfium2。")
            raise SystemExit(EXIT_USAGE) from exc

    return np, Image, RapidOCR, OCRVersion, pdfium


def engine_params(models: dict, OCRVersion) -> dict:
    """OCR 引擎参数：显式模型路径 + 钉死 PP-OCRv5（表格引擎内部 OCR 亦复用此参数）。"""
    return {
        "Det.model_path": str(models["det"]),
        "Det.ocr_version": OCRVersion.PPOCRV5,
        "Rec.model_path": str(models["rec"]),
        "Rec.ocr_version": OCRVersion.PPOCRV5,
        "Cls.model_path": str(models["cls"]),
        "Cls.ocr_version": OCRVersion.PPOCRV5,
        "Global.log_level": "error",
    }


def build_engine(RapidOCR, OCRVersion, models: dict):
    """构造引擎（整轮只构造一次）。显式模型路径 = 离线承诺。

    `ocr_version` 必须显式钉成 PP-OCRv5：三件模型都是 v5 **server** 版，而 rapidocr
    的默认档位是 det/rec=PP-OCRv6、cls=PP-OCRv4。cls 侧这个默认值是**致命的**——
    cls 预处理输入尺寸不看 `cls_image_shape`（配置里那个键是死值），而是查
    `rapidocr/ch_ppocr_cls/main.py` 的 `CLS_SHAPE_BY_OCR_VERSION`：v4→[3,48,192]、
    v5→[3,80,160]。不覆盖就会把 [3,48,192] 的输入喂给要求 [3,80,160] 的 server cls 模型，
    直接 `InvalidArgument: Got invalid dimensions`（2026-09-20 真机踩中）。

    ⚠ 该键是**枚举**参数：`ParseParams.update_batch` 要求 Enum 实例，传字符串会被
    `TypeError: The value of Cls.ocr_version must be Enum Type` 拒掉。
    det/rec 目前不消费该键（v6 默认不影响 v5 权重），一并钉上是为表达「整条链都是 v5」，
    并防 rapidocr 后续版本把它接进 det/rec 的预处理。
    """
    return RapidOCR(params=engine_params(models, OCRVersion))


def iter_pdf_arrays(path: Path, np, pdfium):
    """PDF → 逐页 ndarray（300 DPI）。"""
    document = pdfium.PdfDocument(str(path))
    try:
        # 用文档化了的「len(document) + 下标取页」，不依赖 __iter__。
        for index in range(len(document)):
            bitmap = document[index].render(scale=RENDER_SCALE)
            image = bitmap.to_pil().convert("RGB")
            yield np.asarray(image)
    finally:
        document.close()


def load_image_array(path: Path, np, Image):
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"))


def make_context(models_dir: Path, models: dict, OCRVersion, opts: dict) -> dict:
    """构造本次运行的引擎上下文（版面引擎即时构造；表格引擎惰性构造）。"""
    ctx = {
        "np": None,
        "has_table": bool(opts["table"] and table_ready(models_dir)),
        "layout_engine": None,
        "table_engine": None,
        "ocr_params": engine_params(models, OCRVersion),
        "models_dir": models_dir,
    }
    if opts["layout"] and layout_ready(models_dir):
        try:
            ctx["layout_engine"] = build_layout_engine(models_dir)
        except Exception as exc:  # noqa: BLE001 — 模型在但加载失败：告警 + 跳过该步
            warn(f"版面模型加载失败，已跳过该步（OCR 主路照常）：{type(exc).__name__}: {exc}")
            ctx["layout_engine"] = None

    def get_table_engine():
        if ctx["table_engine"] is None:
            ctx["table_engine"] = build_table_engine(models_dir, ctx["ocr_params"])
        return ctx["table_engine"]

    ctx["get_table_engine"] = get_table_engine
    return ctx


def run_real(input_path: Path, kind: str, models_dir: Path, opts: dict) -> tuple:
    models = require_models(models_dir)
    np, Image, RapidOCR, OCRVersion, pdfium = load_real_dependencies(need_pdf=(kind == "pdf"))
    engine = build_engine(RapidOCR, OCRVersion, models)  # 只构造一次
    ctx = make_context(models_dir, models, OCRVersion, opts)
    ctx["np"] = np
    models_used = {"table": 0, "layout": 0}

    pages = []
    if kind == "pdf":
        for array in iter_pdf_arrays(input_path, np, pdfium):
            pages.append(process_page(engine, array, ctx, opts, models_used))
    else:
        pages.append(process_page(engine, load_image_array(input_path, np, Image), ctx, opts, models_used))
    return pages, models_used


# ---------------------------------------------------------------------------
# --fake 模式
# ---------------------------------------------------------------------------


def fake_pdf_page_count(path: Path) -> int:
    """--fake 下 PDF 仍需真实页数（读页数不涉及推理）。"""
    try:
        import pypdfium2 as pdfium  # noqa: PLC0415
    except ImportError as exc:
        warn(f"--fake 模式处理 PDF 需要 pypdfium2（读取页数），但导入失败：{exc}")
        warn("请先运行  node scripts/setup-ocr.mjs  安装 pypdfium2。")
        raise SystemExit(EXIT_USAGE) from exc
    document = pdfium.PdfDocument(str(path))
    try:
        return len(document)
    finally:
        document.close()


def run_fake(input_path: Path, kind: str) -> tuple:
    count = fake_pdf_page_count(input_path) if kind == "pdf" else 1
    pages = [page_from_lines(MOCK_LINES) for _ in range(count)]
    for page in pages:
        page["lines"] = []
    # --fake 不加载任何模型：models_used 恒 0（结构自测用，SPEC-A1.3 观测点同形）
    return pages, {"table": 0, "layout": 0}


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------


def render_markdown(pages: list) -> str:
    sections = []
    for index, page in enumerate(pages, start=1):
        body = page["text"] if page["blocks"] > 0 else "（未检出文本）"
        sections.append(f"## 第 {index} 页\n\n{body}")
    return "\n\n".join(sections) + "\n" if sections else ""


def render_json(pages: list, input_path: Path, models_used: dict) -> str:
    payload = {
        "file": input_path.name,
        "total_pages": len(pages),
        "models_used": {
            "table": int(models_used.get("table", 0)),
            "layout": int(models_used.get("layout", 0)),
        },
        "pages": [
            {
                "page": index,
                "blocks": page["blocks"],
                "chars": page["chars"],
                "text": page["text"],
            }
            for index, page in enumerate(pages, start=1)
        ],
    }
    return json.dumps(payload, ensure_ascii=False)


def emit(pages: list, input_path: Path, as_json: bool, models_used: dict) -> None:
    if as_json:
        sys.stdout.write(render_json(pages, input_path, models_used) + "\n")
    else:
        sys.stdout.write(render_markdown(pages))


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ocr_main.py",
        description="Prism OCR 工具：图片 / PDF → Markdown 文本（3rd/ocr）。",
    )
    parser.add_argument("input", help="待识别的图片或 PDF 路径")
    parser.add_argument(
        "--models",
        metavar="DIR",
        help="ONNX 模型目录（默认：本脚本同目录 models/）",
    )
    parser.add_argument("--json", action="store_true", help="以 JSON 输出（默认 Markdown）")
    parser.add_argument(
        "--fake",
        action="store_true",
        help="mock 推理层（不加载真实引擎/模型，供无依赖环境自测结构）",
    )
    parser.add_argument(
        "--layout",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="启用版面分析（阅读顺序还原，默认开；--no-layout 关）",
    )
    parser.add_argument(
        "--table",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="启用表格还原（消费 layout 的 table 区域，默认开；--no-table 关）",
    )
    return parser


def main(argv=None) -> int:
    reconfigure_streams()

    args = build_parser().parse_args(argv)

    input_path = Path(args.input)
    if not input_path.is_file():
        die(f"输入文件不存在：{input_path}", EXIT_USAGE)

    kind = classify_input(input_path)
    models_dir = Path(args.models).resolve() if args.models else default_models_dir()
    opts = {"table": bool(args.table), "layout": bool(args.layout)}

    if args.fake:
        pages, models_used = run_fake(input_path, kind)
    else:
        pages, models_used = run_real(input_path, kind, models_dir, opts)
    emit(pages, input_path, as_json=args.json, models_used=models_used)
    return EXIT_OK


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — 兜底：任何意外都给出可读诊断
        warn(f"识别失败：{type(exc).__name__}: {exc}")
        sys.exit(EXIT_RUNTIME)
