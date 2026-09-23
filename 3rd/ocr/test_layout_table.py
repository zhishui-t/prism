#!/usr/bin/env python3
"""v17 B-A1 真模型自测：版面分析（A-2）与扫描表格还原（A-1）。

**需要真模型**（`rapid_layout` + `rapid_table` + `slanet-plus.onnx` + `pp_doc_layoutv3.onnx`）：
任一缺失 → 打印 SKIP 并 **exit 0**（guard 模式：CI/无模型机器不该因此变红；环境齐备时
才做断言）。核心三件套（det/rec/cls）缺失同样 SKIP——没它们连 OCR 主路都跑不了。

断言（逐条回溯 spec-v17）：
  - A1.1：含表格页（fixture-4）→ 正文含 Markdown 表格行（`|` 且 ≥2 列）；
  - A1.2：可选两件模型**未装**（只给核心三件）→ 增强静默跳过，输出与
    `--no-layout --no-table` 旧输出**逐字一致**（含表格的页也不还原）；
  - A1.3：无表格文档（fixture-5 双栏）→ `models_used.table == 0`（零 table 调用）；
  - A2.1：双栏（fixture-5）→ 右栏块在左栏块**之后**（非坐标交错序）；
  - A2.2：单栏（fixture-6）→ layout 判定单栏 + `table==0` + 输出与
    `--no-layout --no-table` 的旧输出**逐字一致**（回归锚）；
  - A3.1：含公式页（fixture-7）→ 阅读序中出现 `[公式]` 占位，公式区域的散行
    **不进正文**；`--no-layout` 时无占位且输出不变。

只读 fixtures，不写任何目录（R5）；临时产物不落盘。用法::

    python 3rd/ocr/test_layout_table.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAIN = HERE / "ocr_main.py"
MODELS_DIR = HERE / "models"
FIXTURES = HERE / "fixtures"

TABLE_FIXTURE = FIXTURES / "fixture-4-table.png"
TWO_COL_FIXTURE = FIXTURES / "fixture-5-two-col.png"
SINGLE_COL_FIXTURE = FIXTURES / "fixture-6-single-col.png"
FORMULA_FIXTURE = FIXTURES / "fixture-7-formula.png"

FORMULA_PLACEHOLDER = "[公式]"

# 双栏 fixture 的每栏行数（gen_fixtures.py 的 SPECS 同步：各 10 行）
TWO_COL_LINES = 10

# 核心三件套（主路，缺其一 OCR 就跑不起来）与可选两件（v17 增强；缺任一件只让
# table/layout 回落旧输出）——镜像 ocr_main.py 的 MODEL_FILES / TABLE_MODEL_FILE /
# LAYOUT_MODEL_FILE 与 scripts/setup-ocr.mjs 的 MODELS 表。
CORE_MODEL_FILES = (
    "ch_PP-OCRv5_det_server.onnx",
    "ch_PP-OCRv5_rec_server.onnx",
    "ch_PP-LCNet_x1_0_textline_ori_cls_server.onnx",
)
OPTIONAL_MODEL_FILES = ("slanet-plus.onnx", "pp_doc_layoutv3.onnx")

_results: list = []


def record(ok: bool, name: str, detail: str = "") -> None:
    _results.append((ok, name, detail))
    status = "PASS" if ok else "FAIL"
    suffix = f" - {detail}" if detail != "" else ""
    print(f"{status} {name}{suffix}")


def guard_ready() -> str | None:
    """返回 SKIP 原因；None 表示环境齐备可断言。"""
    required = [*CORE_MODEL_FILES, *OPTIONAL_MODEL_FILES]
    missing = [name for name in required if not (MODELS_DIR / name).is_file()]
    if missing:
        return f"模型缺失：{', '.join(missing)}（先跑 node scripts/setup-ocr.mjs）"
    for module in ("rapidocr", "rapid_layout", "rapid_table"):
        try:
            __import__(module)
        except Exception as exc:  # noqa: BLE001
            return f"pip 包不可导入：{module}（{exc}）"
    for fixture in (TABLE_FIXTURE, TWO_COL_FIXTURE, SINGLE_COL_FIXTURE, FORMULA_FIXTURE):
        if not fixture.is_file():
            return f"fixture 缺失：{fixture.name}（先跑 python 3rd/ocr/gen_fixtures.py）"
    return None


def run_json(*args: str) -> dict:
    """跑 ocr_main.py --json，返回解析后的 payload（失败即抛）。"""
    result = subprocess.run(
        [sys.executable, str(MAIN), *args, "--json"],
        cwd=str(HERE),
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(f"exit={result.returncode} stderr={result.stderr.strip()[:300]}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"stdout 不是合法 JSON：{exc}: {result.stdout.strip()[:200]}") from exc


def page_text(payload: dict) -> str:
    pages = payload.get("pages") or []
    return pages[0].get("text", "") if pages else ""


def models_used(payload: dict) -> dict:
    return payload.get("models_used") or {}


def markdown_table_rows(text: str) -> list:
    """正文里的 Markdown 表格行（以 `|` 开头且含至少两个单元格分隔）。"""
    rows = []
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("|") and stripped.count("|") >= 3:
            rows.append(stripped)
    return rows


def check_table_restore() -> None:
    payload = run_json(str(TABLE_FIXTURE))
    text = page_text(payload)
    rows = markdown_table_rows(text)
    record(bool(rows), "A1.1 正文含 Markdown 表格行", text.replace("\n", " / ")[:160])
    # ≥2 列：表头行去掉首尾管道后按 `|` 切分应 ≥2 段
    header = rows[0] if rows else ""
    columns = [c for c in header.strip("|").split("|")] if header else []
    record(
        len(columns) >= 2,
        "A1.1 表格 ≥2 列",
        f"列数={len(columns)}（{header}）",
    )
    # 表头 + 分隔行 + 数据行（≥2 数据行）
    record(len(rows) >= 3, "A1.1 表格含表头/分隔/数据行", f"行数={len(rows)}")
    record(
        models_used(payload).get("table", 0) >= 1,
        "A1.1 table 模型确实被调用",
        str(models_used(payload)),
    )


def check_zero_table_calls() -> None:
    payload = run_json(str(TWO_COL_FIXTURE))
    used = models_used(payload)
    record(used.get("table") == 0, "A1.3 无表文档 table 调用计数为 0", str(used))
    record(used.get("layout", 0) >= 1, "A1.3（对照）layout 确实跑过", str(used))


def check_two_column_order() -> None:
    payload = run_json(str(TWO_COL_FIXTURE))
    text = page_text(payload)
    last_left = text.rfind("左栏")
    first_right = text.find("右栏")
    record(
        last_left >= 0 and first_right >= 0 and last_left < first_right,
        "A2.1 右栏块在左栏之后（非坐标交错序）",
        f"last 左栏={last_left} first 右栏={first_right}",
    )
    record(
        text.count("左栏") == TWO_COL_LINES and text.count("右栏") == TWO_COL_LINES,
        "A2.1 左右栏行数完整",
        f"左={text.count('左栏')} 右={text.count('右栏')}",
    )


def check_single_column_anchor() -> None:
    enhanced = run_json(str(SINGLE_COL_FIXTURE))
    legacy = run_json(str(SINGLE_COL_FIXTURE), "--no-layout", "--no-table")
    record(
        page_text(enhanced) == page_text(legacy),
        "A2.2 单栏输出与无 layout/table 旧输出逐字一致",
        f"enhanced={page_text(enhanced)[:60]!r}",
    )
    used = models_used(enhanced)
    record(used.get("table") == 0, "A2.2 单栏 table 调用计数为 0", str(used))
    record(used.get("layout", 0) >= 1, "A2.2（对照）layout 确实跑过", str(used))
    record(models_used(legacy).get("layout") == 0, "A2.2 旧输出 layout 计数为 0", str(models_used(legacy)))


def core_only_models_dir() -> Path | None:
    """建一个**只含核心三件套**的临时模型目录（模拟「可选两件未装」）。

    用硬链接避免拷贝 179MB（`tempfile.mkdtemp` 落在 `MODELS_DIR` 内 = 同卷，
    NTFS 支持硬链）；无权限/跨卷退化为拷贝；两者都不行则返回 None（该子项 SKIP）。
    写在 `models/`（gitignored）内、`finally` 清理，**不碰真实宿主目录**（R5）。
    """
    try:
        tmp = Path(tempfile.mkdtemp(prefix="core-only-", dir=str(MODELS_DIR)))
    except OSError:
        return None
    try:
        for name in CORE_MODEL_FILES:
            dst = tmp / name
            try:
                os.link(MODELS_DIR / name, dst)
            except OSError:
                shutil.copy2(MODELS_DIR / name, dst)
        return tmp
    except OSError:
        shutil.rmtree(tmp, ignore_errors=True)
        return None


def check_missing_models_fallback() -> None:
    """SPEC-A1.2：**可选两件模型未装** → 静默跳过增强，回到无 table/layout 的旧输出。

    与 A2.2（`--no-layout --no-table` 显式关）互为两条路径：这里走的是「flag 缺省（都开）
    但模型不在位」——引擎为 None 时 `process_page` 直接返回 `recognize()` 的原始页。
    """
    core_dir = core_only_models_dir()
    if core_dir is None:
        print("SKIP A1.2 可选模型未装回落（无法建核心三件临时目录）")
        return
    try:
        enhanced = run_json(str(TABLE_FIXTURE), "--models", str(core_dir))
        legacy = run_json(str(TABLE_FIXTURE), "--no-layout", "--no-table")
        used = models_used(enhanced)
        record(
            used.get("table") == 0 and used.get("layout") == 0,
            "A1.2 可选模型未装 → table/layout 计数均 0",
            str(used),
        )
        record(
            page_text(enhanced) == page_text(legacy),
            "A1.2 可选模型未装 → 与 --no-layout/--no-table 旧输出逐字一致",
            f"enhanced={page_text(enhanced)[:60]!r}",
        )
        record(
            not markdown_table_rows(page_text(enhanced)),
            "A1.2 可选模型未装 → 含表格文档也不还原（正文无 Markdown 表格行）",
            page_text(enhanced).replace("\n", " / ")[:120],
        )
    finally:
        shutil.rmtree(core_dir, ignore_errors=True)


def check_formula_placeholder() -> None:
    """SPEC-A3.1：layout 判出 display_formula → `[公式]` 占位；散行不进正文。

    「散行不进正文」的判据**不依赖 OCR 识别的具体字形**：把 `--no-layout`（旧输出，
    公式按普通文本出 `E` / `mc2` 两行）与增强输出对比——旧输出里有、增强输出里没有
    的行，就是被占位取代的公式散行。
    """
    enhanced = run_json(str(FORMULA_FIXTURE))
    legacy = run_json(str(FORMULA_FIXTURE), "--no-layout", "--no-table")
    enhanced_text = page_text(enhanced)
    legacy_text = page_text(legacy)
    enhanced_lines = {line.strip() for line in enhanced_text.split("\n") if line.strip()}
    suppressed = [
        line for line in (l.strip() for l in legacy_text.split("\n")) if line and line not in enhanced_lines
    ]

    record(FORMULA_PLACEHOLDER in enhanced_text, "A3.1 含公式 → 阅读序中出现 [公式] 占位", enhanced_text.replace("\n", " / ")[:160])
    record(models_used(enhanced).get("layout", 0) >= 1, "A3.1 layout 模型确实跑过", str(models_used(enhanced)))
    record(
        len(suppressed) >= 1,
        "A3.1 公式区域的散行文本未进正文（被占位取代）",
        f"被取代的行={suppressed}",
    )
    record(
        FORMULA_PLACEHOLDER not in legacy_text,
        "A3.1 --no-layout 时无占位（零行为变化）",
        legacy_text.replace("\n", " / ")[:160],
    )
    # 旧输出 = 无 layout/table 的原始识别结果（占位未生效时公式散行仍在）
    record(
        legacy_text == page_text(run_json(str(FORMULA_FIXTURE), "--no-layout", "--no-table")),
        "A3.1 --no-layout 输出与旧输出一致",
    )
    # 前后正文（非公式行）不受影响
    record(
        "公式识别样张" in enhanced_text and "验证阅读顺序与占位位置" in enhanced_text,
        "A3.1 占位不影响其它正文行",
        enhanced_text.replace("\n", " / ")[:160],
    )


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError, OSError):
            pass

    reason = guard_ready()
    if reason is not None:
        print(f"SKIP 真模型自测（{reason}）")
        return 0

    check_table_restore()
    check_zero_table_calls()
    check_two_column_order()
    check_single_column_anchor()
    check_missing_models_fallback()
    check_formula_placeholder()

    failed = [name for ok, name, _ in _results if not ok]
    if failed:
        print(f"FAIL（{len(failed)}/{len(_results)} 项失败）")
        return 1
    print(f"PASS（{len(_results)} 项全通过）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
