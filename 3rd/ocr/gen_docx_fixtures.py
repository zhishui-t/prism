#!/usr/bin/env python3
"""生成 v17 B-A4 用的「内嵌图片」docx fixture（**stdlib-only**，不引入新 pip 依赖）。

产物（落 ``3rd/ocr/fixtures/``）：

- ``embed-image.docx``：正文段落 + 一个**独立图片段落**（alt/descr = 中文说明，
  媒体为 PNG）——供 A4.1「内嵌文字截图 → 导入 → 该文字可检索」。
- ``embed-nonwhitelist.docx``：同上，但媒体声明为 ``image/bmp``（24 位 BMP 字节）
  ——供 A4.1「白名单外 mediaType 跳过」分支。

用 ``zipfile`` 手工拼最小 OOXML（Content_Types + 两级 rels + document.xml +
media）。图片字节直接取既有 PNG 样张（``fixture-1-zh.png``），BMP 由本脚本
手工拼 1x1 24 位文件头 + 像素（不依赖 Pillow）。

关键背景（**实测**，见 report）：anydoc 的 Markdown 渲染器对**内嵌 asset 图**
不写 ``![alt](...)``，而是把 **alt 当纯文本内联**（源码
``src/render/markdown/inline.rs`` 的 ``ImageSource::Asset`` 分支）；alt 为空则
什么都不输出。故 Prism 侧的锚点只能是 alt 文本本身。

用法::

    python 3rd/ocr/gen_docx_fixtures.py
"""

from __future__ import annotations

import struct
import sys
import zipfile
from pathlib import Path

EXIT_OK = 0
EXIT_FAIL = 1

HERE = Path(__file__).resolve().parent
FIXTURES_DIR = HERE / "fixtures"
PNG_SOURCE = FIXTURES_DIR / "fixture-1-zh.png"

# 图片的 alt/descr 文本（Word 的 `wp:docPr/@descr`）——A4.1 的锚点。
IMAGE_ALT = "内嵌文字截图说明"

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="{media_ext}" ContentType="{media_type}"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

PACKAGE_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.{media_ext}"/>
</Relationships>"""

DOCUMENT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
<w:p><w:r><w:t>图片上方的一段正文。</w:t></w:r></w:p>
<w:p><w:r><w:drawing>
<wp:inline distT="0" distB="0" distL="0" distR="0">
<wp:extent cx="1905000" cy="952500"/>
<wp:docPr id="1" name="Picture 1" descr="{alt}"/>
<a:graphic>
<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic>
<pic:nvPicPr><pic:cNvPr id="1" name="Picture 1" descr="{alt}"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
</pic:pic>
</a:graphicData>
</a:graphic>
</wp:inline>
</w:drawing></w:r></w:p>
<w:p><w:r><w:t>图片下方的一段正文。</w:t></w:r></w:p>
</w:body></w:document>"""


def warn(message: str) -> None:
    sys.stderr.write(f"[gen-docx] {message}\n")


def minimal_bmp() -> bytes:
    """1x1 24 位 BMP（手工拼头，避免依赖 Pillow）。"""
    row = b"\x00\x00\xff"  # BGR：红
    pixel_data = row + b"\x00"  # 行按 4 字节对齐（1 像素 3 字节 → 补 1 字节）
    header = b"BM" + struct.pack(
        "<IHHI", 14 + 40 + len(pixel_data), 0, 0, 14 + 40
    )
    dib = struct.pack(
        "<IiiHHIIiiII", 40, 1, 1, 1, 24, 0, len(pixel_data), 2835, 2835, 0, 0
    )
    return header + dib + pixel_data


def build_docx(out_path: Path, media_ext: str, media_type: str, media_bytes: bytes) -> None:
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", CONTENT_TYPES.format(media_ext=media_ext, media_type=media_type))
        zf.writestr("_rels/.rels", PACKAGE_RELS)
        zf.writestr("word/_rels/document.xml.rels", DOC_RELS.format(media_ext=media_ext))
        zf.writestr("word/document.xml", DOCUMENT.format(alt=IMAGE_ALT))
        zf.writestr(f"word/media/image1.{media_ext}", media_bytes)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError, OSError):
            pass

    if not PNG_SOURCE.is_file():
        warn(f"缺少图片源 {PNG_SOURCE.name}（先跑 python 3rd/ocr/gen_fixtures.py）")
        return EXIT_FAIL

    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    png_bytes = PNG_SOURCE.read_bytes()

    targets = (
        ("embed-image.docx", "png", "image/png", png_bytes),
        ("embed-nonwhitelist.docx", "bmp", "image/bmp", minimal_bmp()),
    )
    for name, ext, media_type, data in targets:
        out = FIXTURES_DIR / name
        build_docx(out, ext, media_type, data)
        print(f"生成 {name}：{out.stat().st_size} 字节（media={media_type}, alt={IMAGE_ALT!r}）")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
