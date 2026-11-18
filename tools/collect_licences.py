"""Copies the licence texts of every bundled package out of its own wheel into LICENSES/<package>/.

Run from the repository root after changing anything in vendor/:  python tools/collect_licences.py
(Python standard library only; the wheels are only read, never installed.)
"""
import os
import re
import zipfile

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OUT = os.path.join(ROOT, "LICENSES")
LIC = re.compile(r"\.dist-info/(licenses/.+|LICEN[CS]E[^/]*|COPYING[^/]*|NOTICE[^/]*|AUTHORS[^/]*)$", re.I)

found = {}
for sub in ("vendor/pyodide", "vendor/wheels"):
    folder = os.path.join(ROOT, sub)
    for whl in sorted(os.listdir(folder)):
        if not whl.endswith(".whl"):
            continue
        name = whl.split("-")[0]
        with zipfile.ZipFile(os.path.join(folder, whl)) as z:
            files = [n for n in z.namelist() if LIC.search(n)]
            for n in files:
                dst = os.path.join(OUT, name, os.path.basename(n))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                with open(dst, "wb") as fh:
                    fh.write(z.read(n))
            found[name] = [os.path.basename(n) for n in files]
for name, files in found.items():
    print(f"{name:22s} {', '.join(files) if files else 'NO LICENCE FILE IN THE WHEEL'}")
