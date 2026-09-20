#!/usr/bin/env python3
"""3rd/ocr 无依赖自测（**stdlib-only**）：跑 ocr_main.py 的 --fake 路径与用法守卫。

不 import rapidocr / pypdfium2（本文件不含 PDF 断言，故无需任何三方依赖）。
用 subprocess 覆盖：

  1. ``--fake``（图片）→ stdout Markdown 含 ``## 第 1 页`` 与 mock 标记，exit 0；
  2. ``--fake --json``（图片）→ stdout 可 JSON 解析，pages[0].page == 1，exit 0；
  3. 无参数 / 坏参数 → exit 2（用法错误）。

用法::

    python 3rd/ocr/test_smoke.py

打印 PASS / FAIL，任一失败以非零退出码表示。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAIN = HERE / "ocr_main.py"
TINY_FIXTURE = HERE / "fixtures" / "fixture-3-tiny.png"
MOCK_MARKER = "PRISM OCR MOCK"

_results: list = []


def record(ok: bool, name: str, detail: str = "") -> None:
    _results.append((ok, name, detail))
    status = "PASS" if ok else "FAIL"
    suffix = f" - {detail}" if detail != "" else ""
    print(f"{status} {name}{suffix}")


def run_main(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(MAIN), *args],
        cwd=str(HERE),
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )


def rel(path: Path) -> str:
    """相对 3rd/ocr 的路径（子进程 cwd 固定为 HERE，避免绝对路径噪音）。"""
    try:
        return path.relative_to(HERE).as_posix()
    except ValueError:
        return str(path)


def check_markdown() -> None:
    result = run_main(rel(TINY_FIXTURE), "--fake")
    if result.returncode != 0:
        record(False, "markdown --fake exit 0", f"exit={result.returncode} stderr={result.stderr.strip()}")
        return
    record(True, "markdown --fake exit 0")
    record("## 第 1 页" in result.stdout, "markdown 含分节标题", result.stdout.strip()[:80])
    record(MOCK_MARKER in result.stdout, "markdown 含 mock 标记")


def check_json() -> None:
    result = run_main(rel(TINY_FIXTURE), "--fake", "--json")
    if result.returncode != 0:
        record(False, "json --fake exit 0", f"exit={result.returncode} stderr={result.stderr.strip()}")
        return
    record(True, "json --fake exit 0")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        record(False, "json 可解析", f"{exc}: {result.stdout.strip()[:120]}")
        return
    record(True, "json 可解析")
    pages = payload.get("pages") or []
    record(bool(pages) and pages[0].get("page") == 1, "json pages[0].page == 1")
    record(payload.get("total_pages") == 1, "json total_pages == 1")
    record(payload.get("file") == TINY_FIXTURE.name, "json file 为输入文件名")


def check_usage_guards() -> None:
    no_args = run_main()
    record(no_args.returncode == 2, "无参数 exit 2", f"exit={no_args.returncode}")

    bad_flag = run_main(rel(TINY_FIXTURE), "--nope")
    record(bad_flag.returncode == 2, "未知参数 exit 2", f"exit={bad_flag.returncode}")

    missing_value = run_main(rel(TINY_FIXTURE), "--models")
    record(missing_value.returncode == 2, "--models 缺值 exit 2", f"exit={missing_value.returncode}")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError, OSError):
            pass

    if not TINY_FIXTURE.is_file():
        print(f"FAIL 缺少 fixture：{TINY_FIXTURE}")
        print("     请先运行： python 3rd/ocr/gen_fixtures.py")
        return 1

    check_markdown()
    check_json()
    check_usage_guards()

    failed = [name for ok, name, _ in _results if not ok]
    if failed:
        print(f"FAIL（{len(failed)}/{len(_results)} 项失败）")
        return 1
    print(f"PASS（{len(_results)} 项全通过）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
