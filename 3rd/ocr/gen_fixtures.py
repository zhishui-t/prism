#!/usr/bin/env python3
"""生成 3rd/ocr/fixtures/ 的三张 KB 级小图 + expected.json（Pillow 本地绘制，无网络图）。

三张图是后续 B-4「少文本守卫」与 OCR 自测的固定输入：

- ``fixture-1-zh.png``：中文多行 + 数字，有效字符（CJK + [A-Za-z0-9]）≥50；
- ``fixture-2-en.png``：纯英数多行，有效字符 ≥50；
- ``fixture-3-tiny.png``：极短文本，有效字符 <50（供「少文本跳过」守卫测试）。

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
        "size": (440, 190),
        "font_size": 36,
        "margin": 30,
        "line_gap": 16,
        "lines": ("小样张 PRISM",),
        "substrings": ("小样张", "PRISM"),
        # 守卫测试要求：有效字符 <50
        "max_valid_chars": 49,
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


def draw_fixture(spec: dict, font_path: Path) -> tuple:
    """绘制单张图，返回 (字节数, 有效字符数)。"""
    from PIL import Image, ImageDraw, ImageFont  # noqa: PLC0415 — 延迟 import 以便缺依赖时报错清晰

    width, height = spec["size"]
    font = ImageFont.truetype(str(font_path), spec["font_size"])

    image = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    y = spec["margin"]
    for line in spec["lines"]:
        draw.text((spec["margin"], y), line, font=font, fill=(0, 0, 0))
        y += spec["font_size"] + spec["line_gap"]

    out_path = FIXTURES_DIR / spec["file"]
    image.save(out_path, format="PNG")

    text = "\n".join(spec["lines"])
    return out_path.stat().st_size, valid_char_count(text)


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
                "substrings": list(spec["substrings"]),
                "valid_chars": chars,
            }
        )
        print(f"生成 {spec['file']}：{size_bytes} 字节，有效字符 {chars}")

    expected = {
        "note": "由 gen_fixtures.py 生成；供后续少文本守卫与 OCR 自测断言使用。",
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
