"""Convert BENCHMARK_REPORT.md + GATE_AUDIT.md into a professional Word document."""
import pypandoc
from pathlib import Path

AUDIT_DIR = Path(r"C:\Users\user\Desktop\Trade Bot\Trade Bot\audit")
REPORT_MD = AUDIT_DIR / "BENCHMARK_REPORT.md"
GATE_MD = Path(r"C:\Users\user\Downloads\_benchmark\farad\GATE_AUDIT.md")
OUT_DOCX = AUDIT_DIR / "BENCHMARK_REPORT.docx"

cover = """---
title: "Farad Trading Bot — Benchmark & Audit Report"
subtitle: "Commissioned by Giuseppe · 2026-04-21"
author: "BetterOpsAI"
date: "2026-04-21"
toc: true
toc-depth: 3
numbersections: true
geometry: margin=1in
fontsize: 11pt
mainfont: "Calibri"
---

\\newpage

"""

appendix_header = """

\\newpage

# Appendix A — Gate Audit (source document)

_This appendix contains the full text of the gate audit conducted by the Gate-Auditor agent. This document was the primary input for the "Will Farad Ever Trade?" section of the main report._

"""

report_body = REPORT_MD.read_text(encoding="utf-8")
gate_body = GATE_MD.read_text(encoding="utf-8")

# Demote gate audit headings by one level so they nest under Appendix A
gate_body_demoted = "\n".join(
    ("#" + line) if line.startswith("#") else line
    for line in gate_body.splitlines()
)

combined = cover + report_body + appendix_header + gate_body_demoted

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
print(f"OK — wrote {OUT_DOCX} ({size_kb:.1f} KB)")
