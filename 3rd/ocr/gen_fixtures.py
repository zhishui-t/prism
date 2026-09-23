#!/usr/bin/env python3
"""生成 3rd/ocr/fixtures/ 的 KB 级小图 + expected.json（Pillow 本地绘制，无网络图）。

**核心三张**（v14 B-4，少文本守卫与 OCR 自测的固定输入）：

- ``fixture-1-zh.png``：中文多行 + 数字，有效字符（CJK + [A-Za-z0-9]）≥50；
- ``fixture-2-en.png``：纯英数多行，有效字符 ≥50；
- ``fixture-3-tiny.png``：极短文本，有效字符 <50（供「少文本跳过」守卫测试）。

**版面 / 表格三张**（v17 B-A1，真模型断言用；需装 rapid_layout + rapid_table）：

- ``fixture-4-table.png``：单栏 + 一个带框线表格（供 A1.1 表格还原 / A1.3 计数）；
- ``fixture-5-two-col.png``：标题 + 左右双栏（供 A2.1 阅读顺序）；
- ``fixture-6-single-col.png``：单栏（供 A2.2「与旧输出逐字一致」回归锚）；
- ``fixture-7-formula.png``：单栏 + 一个大字号**独立公式块**（供 A3.1 公式占位）。

⚠ 公式页的绘法是**实测**定下的：pp_doc_layoutv3 只在「足够大 + 居中 + 上下留白」
时才把 ``E = mc2`` 判成 ``display_formula``（96px 居中命中，64px 或混排 ``y = ax2 +
bx + c`` 都不命中）——改动公式页尺寸/字号前先重新实测检出。

有效字符口径与 v14 设计一致：CJK 计 1、``[A-Za-z0-9]`` 计 1、空白与标点计 0。

字体按平台候选列表探测（Windows msyh/simhei、macOS PingFang/STHeiti、Linux
NotoSansCJK 等），全无则报错退出；可用 ``PRISM_OCR_FONT`` 指定字体文件覆盖。
脚本可重复执行（覆盖输出）。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

EXIT_OK = 0
EXIT_FAIL = 1

HERE = Path(__file__).resolve().parent
FIXTURES_DIR = HERE / "fixtures"

# 字体候选（按平台分组，取首个存在者）。.ttc 集合默认取 index 0。
FONT_CANDIDATES = (
    # Windows
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyh.ttf",
    r"C:\Windows\Fonts\msyhl.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
    # macOS
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    # Linux
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
)

# 每张图的绘制规格与预期子串。字号一律 ≥24。
SPECS = (
    {
        "file": "fixture-1-zh.png",
        "kind": "lines",
        "size": (720, 360),
        "font_size": 32,
        "margin": 28,
        "line_gap": 14,
        "lines": (
            "Prism 知识库 OCR 样张",
            "第二行：知识检索与图谱融合",
            "编号 2026-0920",
            "扫描版 PDF 与图片转 Markdown",
        ),
        "substrings": ("Prism", "知识库", "知识检索与图谱融合", "2026-0920", "Markdown"),
        "min_valid_chars": 50,
    },
    {
        "file": "fixture-2-en.png",
        "kind": "lines",
        "size": (760, 260),
        "font_size": 28,
        "margin": 28,
        "line_gap": 16,
        "lines": (
            "RapidOCR pipeline renders 300 DPI pages",
            "with pypdfium2 and recognizes text",
            "via onnxruntime.",
        ),
        "substrings": ("RapidOCR", "pypdfium2", "onnxruntime", "300 DPI"),
        "min_valid_chars": 50,
    },
    {
        "file": "fixture-3-tiny.png",
        "kind": "lines",
        "size": (440, 190),
        "font_size": 36,
        "margin": 30,
        "line_gap": 16,
        "lines": ("小样张 PRISM",),
        "substrings": ("小样张", "PRISM"),
        # 守卫测试要求：有效字符 <50
        "max_valid_chars": 49,
    },
    {
        "file": "fixture-4-table.png",
        "kind": "table",
        "size": (1000, 1200),
        "title": "产品报价单",
        "intro": "下表列出各型号价格与库存。",
        "outro": "以上价格含税，最终以合同为准。",
        "grid": (60, 180, 940, 420),
        "col_bounds": (60, 300, 540, 940),
        "row_bounds": (180, 260, 340, 420),
        "cells": (
            ("型号", "价格", "库存"),
            ("A100", "1999", "12"),
            ("B200", "2999", "5"),
        ),
        "substrings": ("产品报价单", "型号", "价格", "库存", "A100", "1999"),
        "min_valid_chars": 50,
    },
    {
        "file": "fixture-5-two-col.png",
        "kind": "two-col",
        "size": (1200, 1500),
        "title": "双栏文档标题",
        "left_x": 80,
        "right_x": 660,
        "first_y": 200,
        "line_gap": 60,
        "lines": (
            "左栏第1行文字内容示例",
            "左栏第2行文字内容示例",
            "左栏第3行文字内容示例",
            "左栏第4行文字内容示例",
            "左栏第5行文字内容示例",
            "左栏第6行文字内容示例",
            "左栏第7行文字内容示例",
            "左栏第8行文字内容示例",
            "左栏第9行文字内容示例",
            "左栏第10行文字内容示例",
        ),
        "right_lines": (
            "右栏第1行文字内容示例",
            "右栏第2行文字内容示例",
            "右栏第3行文字内容示例",
            "右栏第4行文字内容示例",
            "右栏第5行文字内容示例",
            "右栏第6行文字内容示例",
            "右栏第7行文字内容示例",
            "右栏第8行文字内容示例",
            "右栏第9行文字内容示例",
            "右栏第10行文字内容示例",
        ),
        "substrings": ("双栏文档标题", "左栏", "右栏"),
        "min_valid_chars": 50,
    },
    {
        "file": "fixture-6-single-col.png",
        "kind": "single-col",
        "size": (1200, 1500),
        "title": "单栏文档示例标题",
        "left_x": 80,
        "first_y": 200,
        "line_gap": 70,
        "lines": (
            "第1行正文内容示例文字",
            "第2行正文内容示例文字",
            "第3行正文内容示例文字",
            "第4行正文内容示例文字",
            "第5行正文内容示例文字",
            "第6行正文内容示例文字",
            "第7行正文内容示例文字",
            "第8行正文内容示例文字",
            "第9行正文内容示例文字",
            "第10行正文内容示例文字",
            "第11行正文内容示例文字",
            "第12行正文内容示例文字",
        ),
        "substrings": ("单栏文档示例标题", "正文内容示例文字"),
        "min_valid_chars": 50,
    },
    {
        "file": "fixture-7-formula.png",
        "kind": "formula",
        "size": (1200, 1500),
        "title": "公式识别样张",
        "title_size": 56,
        "intro": "本页包含一个独立公式块，用于版面公式检测。",
        "formula": "E = mc2",
        "formula_size": 96,
        "formula_y": 560,
        "outro_lines": ("公式之后继续正文内容示例，并", "验证阅读顺序与占位位置。"),
        "body_size": 40,
        "substrings": ("公式识别样张", "独立公式块"),
        "min_valid_chars": 50,
    },
)


def warn(message: str) -> None:
    sys.stderr.write(f"[gen-fixtures] {message}\n")


def is_valid_char(char: str) -> bool:
    """有效字符 = CJK 汉字 或 ASCII 字母数字（空白/标点不计）。"""
    if "0" <= char <= "9" or "a" <= char <= "z" or "A" <= char <= "Z":
        return True
    return "\u4e00" <= char <= "\u9fff"


def valid_char_count(text: str) -> int:
    return sum(1 for char in text if is_valid_char(char))


def resolve_font_path() -> Path:
    override = (os.environ.get("PRISM_OCR_FONT") or "").strip()
    if override != "":
        path = Path(override)
        if not path.is_file():
            warn(f"PRISM_OCR_FONT 指向的字体不存在：{path}")
            raise SystemExit(EXIT_FAIL)
        return path

    for candidate in FONT_CANDIDATES:
        if Path(candidate).is_file():
            return Path(candidate)

    warn("未找到任何可用 CJK 字体。已尝试以下候选：")
    for candidate in FONT_CANDIDATES:
        warn(f"  - {candidate}")
    warn("可用 PRISM_OCR_FONT 指定字体文件后重试。")
    raise SystemExit(EXIT_FAIL)


def spec_text(spec: dict) -> str:
    """样张的「预期文本」（有效字符计数与子串断言的依据）。"""
    kind = spec.get("kind", "lines")
    if kind == "table":
        cells = "\n".join(" ".join(row) for row in spec["cells"])
        return "\n".join((spec["title"], spec["intro"], cells, spec["outro"]))
    if kind == "two-col":
        return "\n".join((spec["title"], *spec["lines"], *spec["right_lines"]))
    if kind == "formula":
        return "\n".join((spec["title"], spec["intro"], spec["formula"], *spec["outro_lines"]))
    return "\n".join((spec.get("title", ""), *spec["lines"])).strip()


def draw_lines(spec: dict, font_path: Path):
    from PIL import Image, ImageDraw, ImageFont  # noqa: PLC0415 — 延迟 import 以便缺依赖时报错清晰

    width, height = spec["size"]
    font = ImageFont.truetype(str(font_path), spec["font_size"])
    image = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    y = spec["margin"]
    for line in spec["lines"]:
        draw.text((spec["margin"], y), line, font=font, fill=(0, 0, 0))
        y += spec["font_size"] + spec["line_gap"]
    return image


def draw_table(spec: dict, font_path: Path):
    """单栏 + 带框线表格（框线增强版面特征，便于 layout 判定 table 区域）。"""
    from PIL import Image, ImageDraw, ImageFont  # noqa: PLC0415

    width, height = spec["size"]
    image = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    title_font = ImageFont.truetype(str(font_path), 40)
    body_font = ImageFont.truetype(str(font_path), 30)

    draw.text((60, 40), spec["title"], font=title_font, fill=(0, 0, 0))
    draw.text((60, 110), spec["intro"], font=body_font, fill=(0, 0, 0))

    x0, y0, x1, y1 = spec["grid"]
    for x in spec["col_bounds"]:
        draw.line([(x, y0), (x, y1)], fill=(0, 0, 0), width=3)
    for y in spec["row_bounds"]:
        draw.line([(x0, y), (x1, y)], fill=(0, 0, 0), width=3)

    cols = spec["col_bounds"]
    rows = spec["row_bounds"]
    for r, row in enumerate(spec["cells"]):
        for c, text in enumerate(row):
            draw.text((cols[c] + 20, rows[r] + 22), text, font=body_font, fill=(0, 0, 0))

    draw.text((60, 460), spec["outro"], font=body_font, fill=(0, 0, 0))
    return image


def draw_two_col(spec: dict, font_path: Path):
    from PIL import Image, ImageDraw, ImageFont  # noqa: PLC0415

    width, height = spec["size"]
    image = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.text((spec["left_x"], 50), spec["title"], font=ImageFont.truetype(str(font_path), 56), fill=(0, 0, 0))
    font = ImageFont.truetype(str(font_path), 40)
    for x, lines in ((spec["left_x"], spec["lines"]), (spec["right_x"], spec["right_lines"])):
        y = spec["first_y"]
        for line in lines:
            draw.text((x, y), line, font=font, fill=(0, 0, 0))
            y += spec["line_gap"]
    return image


def draw_single_col(spec: dict, font_path: Path):
    from PIL import Image, ImageDraw, ImageFont  # noqa: PLC0415

    width, height = spec["size"]
    image = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.text((spec["left_x"], 50), spec["title"], font=ImageFont.truetype(str(font_path), 56), fill=(0, 0, 0))
    font = ImageFont.truetype(str(font_path), 40)
    y = spec["first_y"]
    for line in spec["lines"]:
        draw.text((spec["left_x"], y), line, font=font, fill=(0, 0, 0))
        y += spec["line_gap"]
    return image


def draw_formula(spec: dict, font_path: Path):
    """单栏 + 一个**居中、大字号、上下留白**的独立公式块（A-3 检出前提）。"""
    from PIL import Image, ImageDraw, ImageFont  # noqa: PLC0415

    width, height = spec["size"]
    image = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.text(
        (80, 50),
        spec["title"],
        font=ImageFont.truetype(str(font_path), spec["title_size"]),
        fill=(0, 0, 0),
    )
    draw.text(
        (80, 200),
        spec["intro"],
        font=ImageFont.truetype(str(font_path), spec["body_size"]),
        fill=(0, 0, 0),
    )
    formula_font = ImageFont.truetype(str(font_path), spec["formula_size"])
    text_width = draw.textbbox((0, 0), spec["formula"], font=formula_font)[2]
    draw.text(
        ((width - text_width) // 2, spec["formula_y"]),
        spec["formula"],
        font=formula_font,
        fill=(0, 0, 0),
    )
    body_font = ImageFont.truetype(str(font_path), spec["body_size"])
    y = 900
    for line in spec["outro_lines"]:
        draw.text((80, y), line, font=body_font, fill=(0, 0, 0))
        y += spec["body_size"] + 30
    return image


DRAWERS = {
    "lines": draw_lines,
    "table": draw_table,
    "two-col": draw_two_col,
    "single-col": draw_single_col,
    "formula": draw_formula,
}


def draw_fixture(spec: dict, font_path: Path) -> tuple:
    """绘制单张图，返回 (字节数, 有效字符数)。"""
    image = DRAWERS[spec.get("kind", "lines")](spec, font_path)
    out_path = FIXTURES_DIR / spec["file"]
    image.save(out_path, format="PNG")
    return out_path.stat().st_size, valid_char_count(spec_text(spec))


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError, OSError):
            pass

    try:
        from PIL import __version__ as pillow_version  # noqa: PLC0415
    except ImportError as exc:
        warn(f"缺少 Pillow（{exc}）——请先执行：python -m pip install pillow")
        return EXIT_FAIL

    font_path = resolve_font_path()
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)

    print(f"字体：{font_path}")
    print(f"Pillow：{pillow_version}")

    entries = []
    for spec in SPECS:
        size_bytes, chars = draw_fixture(spec, font_path)

        if "min_valid_chars" in spec and chars < spec["min_valid_chars"]:
            warn(
                f"{spec['file']} 有效字符 {chars} < 下限 {spec['min_valid_chars']}，"
                "请调整样张文本"
            )
            return EXIT_FAIL
        if "max_valid_chars" in spec and chars > spec["max_valid_chars"]:
            warn(
                f"{spec['file']} 有效字符 {chars} > 上限 {spec['max_valid_chars']}，"
                "请缩短样张文本"
            )
            return EXIT_FAIL

        entries.append(
            {
                "file": spec["file"],
                "kind": spec.get("kind", "lines"),
                "substrings": list(spec["substrings"]),
                "valid_chars": chars,
            }
        )
        print(f"生成 {spec['file']}：{size_bytes} 字节，有效字符 {chars}")

    expected = {
        "note": "由 gen_fixtures.py 生成；供少文本守卫、OCR 自测与 v17 版面/表格断言使用。",
        "valid_char_rule": "CJK 计 1 + [A-Za-z0-9] 计 1；空白/标点计 0",
        "fixtures": entries,
    }
    expected_path = FIXTURES_DIR / "expected.json"
    expected_path.write_text(
        json.dumps(expected, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"写入 {expected_path.relative_to(HERE)}（{expected_path.stat().st_size} 字节）")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

