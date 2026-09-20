#!/usr/bin/env python3
"""Prism OCR 工具主体（3rd/ocr）：图片 / PDF → Markdown 文本。

用法（一般由同目录的 ocr_tool.mjs 薄壳调用）::

    python ocr_main.py <input> [--models <dir>] [--json] [--fake]

真实模式
    用 pypdfium2 把 PDF 按 300 DPI 栅格化（图片直接 PIL 打开转 RGB），逐页交给
    RapidOCR（onnxruntime 后端）识别，cls 方向分类由引擎内部完成。**显式传
    Det/Rec/Cls 三件模型路径**——rapidocr 缺省首跑会自动联网把模型拉到
    site-packages，显式路径堵死该行为；模型缺失即报错退出，**绝不回落联网**。
    三件都是 PP-OCRv5 **server** 权重，故还须把 `ocr_version` 钉成 PP-OCRv5
    （cls 的预处理尺寸由它决定，默认 PP-OCRv4 会形状不符直接报错，详见 build_engine）。

--fake
    mock 推理层：不 import rapidocr 真引擎（PDF 读页数仍需 pypdfium2），供无依赖、
    无模型的机器自测 stdout / JSON 结构。图片输出固定 mock 文本。

输出约定（给消费方 packages/knowledge/src/convert.ts）
    stdout 只放结果：默认 Markdown（每页一个小节 ``## 第 N 页``），``--json`` 时放单个
    JSON（``ensure_ascii=False``）。**一切诊断/日志走 stderr**（Windows 控制台 GBK 陷阱）。
    少文本跳过判定**不在这里做**——那是 Prism 侧的守卫，本工具只负责识别。

退出码
    0 成功；1 意外运行时错误；2 用法错误 / 输入不存在 / 模型缺失 / pip 依赖缺失。

本文件为独立 Python 工具，不依赖本仓任何 TS 代码。解释器解析的镜像契约见
同目录 ocr_tool.mjs（M6 三件套：scripts/python.mjs 规范源 + graphify.ts + 本工具）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

EXIT_OK = 0
EXIT_RUNTIME = 1
EXIT_USAGE = 2

# 三件套 ONNX 的固定文件名（PP-OCRv5 server，由 scripts/setup-ocr.mjs 落到
# <models>/；见 3rd/ocr/requirements.txt 与 README.md）。
MODEL_FILES = {
    "det": "ch_PP-OCRv5_det_server.onnx",
    "rec": "ch_PP-OCRv5_rec_server.onnx",
    "cls": "ch_PP-LCNet_x1_0_textline_ori_cls_server.onnx",
}

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
    """检查三件 ONNX 是否齐备；缺失即中文报错 + 退出 2（不联网兜底）。"""
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


def recognize(engine, array) -> dict:
    """跑一次引擎，取 result.txts（str 元组或 None）→ 页结果。"""
    result = engine(array)
    txts = getattr(result, "txts", None)
    return page_from_lines(txts if txts is not None else ())


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
    params = {
        "Det.model_path": str(models["det"]),
        "Det.ocr_version": OCRVersion.PPOCRV5,
        "Rec.model_path": str(models["rec"]),
        "Rec.ocr_version": OCRVersion.PPOCRV5,
        "Cls.model_path": str(models["cls"]),
        "Cls.ocr_version": OCRVersion.PPOCRV5,
        "Global.log_level": "error",
    }
    return RapidOCR(params=params)


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


def run_real(input_path: Path, kind: str, models_dir: Path) -> list:
    models = require_models(models_dir)
    np, Image, RapidOCR, OCRVersion, pdfium = load_real_dependencies(need_pdf=(kind == "pdf"))
    engine = build_engine(RapidOCR, OCRVersion, models)  # 只构造一次
    pages = []
    if kind == "pdf":
        for array in iter_pdf_arrays(input_path, np, pdfium):
            pages.append(recognize(engine, array))
    else:
        pages.append(recognize(engine, load_image_array(input_path, np, Image)))
    return pages


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


def run_fake(input_path: Path, kind: str) -> list:
    count = fake_pdf_page_count(input_path) if kind == "pdf" else 1
    return [page_from_lines(MOCK_LINES) for _ in range(count)]


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------


def render_markdown(pages: list) -> str:
    sections = []
    for index, page in enumerate(pages, start=1):
        body = page["text"] if page["blocks"] > 0 else "（未检出文本）"
        sections.append(f"## 第 {index} 页\n\n{body}")
    return "\n\n".join(sections) + "\n" if sections else ""


def render_json(pages: list, input_path: Path) -> str:
    payload = {
        "file": input_path.name,
        "total_pages": len(pages),
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


def emit(pages: list, input_path: Path, as_json: bool) -> None:
    if as_json:
        sys.stdout.write(render_json(pages, input_path) + "\n")
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
    return parser


def main(argv=None) -> int:
    reconfigure_streams()

    args = build_parser().parse_args(argv)

    input_path = Path(args.input)
    if not input_path.is_file():
        die(f"输入文件不存在：{input_path}", EXIT_USAGE)

    kind = classify_input(input_path)
    models_dir = Path(args.models).resolve() if args.models else default_models_dir()

    pages = run_fake(input_path, kind) if args.fake else run_real(input_path, kind, models_dir)
    emit(pages, input_path, as_json=args.json)
    return EXIT_OK


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — 兜底：任何意外都给出可读诊断
        warn(f"识别失败：{type(exc).__name__}: {exc}")
        sys.exit(EXIT_RUNTIME)
