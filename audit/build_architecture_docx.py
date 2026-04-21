"""Convert ARCHITECTURE_offline_replay.md into a professional Word document."""
import pypandoc
from pathlib import Path

AUDIT_DIR = Path(r"C:\Users\user\Desktop\Trade Bot\Trade Bot\audit")
SOURCE_MD = AUDIT_DIR / "ARCHITECTURE_offline_replay.md"
OUT_DOCX = AUDIT_DIR / "ARCHITECTURE_offline_replay.docx"

cover = """---
title: "Architecture — Offline Candle Replay Harness"
subtitle: "Farad Trading Bot · P0 Item #2 from BENCHMARK_REPORT · 2026-04-21"
author: "BetterOpsAI"
date: "2026-04-21"
toc: true
toc-depth: 3
numbersections: true
geometry: margin=1in
fontsize: 11pt
---

\\newpage

"""

body = SOURCE_MD.read_text(encoding="utf-8")
combined = cover + body

pypandoc.convert_text(
    combined,
    to="docx",
    format="markdown+pipe_tables+yaml_metadata_block",
    outputfile=str(OUT_DOCX),
    extra_args=[
        "--toc",
        "--toc-depth=3",
        "--standalone",
        "--number-sections",
    ],
)

size_kb = OUT_DOCX.stat().st_size / 1024
print(f"OK - wrote {OUT_DOCX} ({size_kb:.1f} KB)")
