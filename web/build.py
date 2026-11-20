#!/usr/bin/env python3
"""Встраивает index.html в worker.template.js → worker.js (один файл для Cloudflare)."""
import json, pathlib
here = pathlib.Path(__file__).parent
page = (here / "index.html").read_text(encoding="utf-8")
tpl = (here / "worker.template.js").read_text(encoding="utf-8")
(here / "worker.js").write_text(tpl.replace("__PAGE__", json.dumps(page, ensure_ascii=False)), encoding="utf-8")
print("worker.js собран")
