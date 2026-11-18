"""Phase 0 measurement runner (TEST ONLY, never part of the published site).

Serves the proof of concept (poc/) on 127.0.0.1, lends the page IFC files from a folder given on the command line
(they are read in place, never copied), and stores what the page posts back (DXF, report, measure.json) under
--out/<tag>/. Each run opens a fresh headless browser profile, waits for measure.json, then closes the browser.

Usage (Python standard library only):
  python tools/phase0_measure.py --ifc-dir "<folder with the IFCs>" --out _local_test_results/phase0 \
      --browser edge="C:/.../msedge.exe" --browser chrome="C:/.../chrome.exe" \
      --run WAS1=SB_..._000001_....ifc --run ELE_nolabels=<file>.ifc:{"data_texts":false}
"""
import argparse
import functools
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
POC = os.path.normpath(os.path.join(HERE, "..", "poc"))
SAFE = re.compile(r"^[A-Za-z0-9._-]+$")


class Handler(http.server.SimpleHTTPRequestHandler):
    ifc_dir = out_dir = None
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map,
                          **{".wasm": "application/wasm", ".mjs": "text/javascript", ".js": "text/javascript",
                             ".whl": "application/zip", ".zip": "application/zip"})

    def log_message(self, fmt, *args):      # quiet: only errors
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("HTTP " + fmt % args + "\n")

    extra = None

    def do_GET(self):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        if path.startswith("/_extra/"):
            if not self.extra or path[len("/_extra/"):] != os.path.basename(self.extra):
                return self.send_error(404)
            with open(self.extra, "rb") as fh:
                data = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path.startswith("/_ifc/"):
            name = path[len("/_ifc/"):]
            full = os.path.join(self.ifc_dir, name)
            if os.path.dirname(name) or not name.lower().endswith(".ifc") or not os.path.isfile(full):
                return self.send_error(404)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(os.path.getsize(full)))
            self.end_headers()
            with open(full, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile)
            return
        return super().do_GET()

    def do_POST(self):
        parts = urllib.parse.unquote(urllib.parse.urlparse(self.path).path).strip("/").split("/")
        if len(parts) != 3 or parts[0] != "_results" or not SAFE.match(parts[1]) or not SAFE.match(parts[2]):
            return self.send_error(400)
        n = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(n)
        os.makedirs(os.path.join(self.out_dir, parts[1]), exist_ok=True)
        with open(os.path.join(self.out_dir, parts[1], parts[2]), "wb") as fh:
            fh.write(data)
        self.send_response(204)
        self.end_headers()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ifc-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--browser", action="append", default=[], help="name=path to the browser executable")
    ap.add_argument("--run", action="append", default=[], help='tag=file.ifc[:{"option": value}]')
    ap.add_argument("--timeout", type=float, default=3600)
    ap.add_argument("--serve-only", action="store_true", help="only serve (for manual tests in a normal browser)")
    ap.add_argument("--page", default="index.html", help="index.html (measurement) or diag.html (diagnostics)")
    ap.add_argument("--root", action="store_true", help="serve the repository root (the app) instead of poc/")
    ap.add_argument("--extra-file", help="one more local file lent to the page at /_extra/<name> (e.g. an AI .json)")
    ap.add_argument("--query", default="", help="extra query string for the page, e.g. pyodide=vendor/x/&wheel=y.whl")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    Handler.ifc_dir, Handler.out_dir = os.path.abspath(a.ifc_dir), os.path.abspath(a.out)
    Handler.extra = os.path.abspath(a.extra_file) if a.extra_file else None
    served = os.path.normpath(os.path.join(HERE, "..")) if a.root else POC
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), functools.partial(Handler, directory=served))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"serving {served} on http://127.0.0.1:{a.port}/", flush=True)
    if a.serve_only:
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            return
    for b in a.browser:
        bname, bexe = b.split("=", 1)
        for r in a.run:
            tag, spec = r.split("=", 1)
            ifc, _, opts = spec.partition(":")
            full_tag = f"{bname}_{tag}"
            diag = a.page == "diag.html"
            target = os.path.join(a.out, full_tag, "diag.json" if diag else "measure.json")
            if os.path.exists(target):
                print(f"{full_tag}: already measured, skipped", flush=True)
                continue
            q = urllib.parse.urlencode({"ifc" if diag else "auto": "/_ifc/" + ifc, "tag": full_tag,
                                        "post": "/_results", "opts": opts or "{}",
                                        **({"ai": "/_extra/" + os.path.basename(a.extra_file)} if a.extra_file else {})})
            url = f"http://127.0.0.1:{a.port}/{a.page}?{q}" + (f"&{a.query}" if a.query else "")
            profile = tempfile.mkdtemp(prefix="ifc2dxf_profile_")
            t0 = time.time()
            p = subprocess.Popen([bexe, "--headless=new", f"--user-data-dir={profile}", "--no-first-run",
                                  "--no-default-browser-check", "--disable-extensions", "--disable-sync",
                                  "--disable-background-networking", "--disable-component-update", url],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            def finished():
                if not os.path.exists(target):
                    return False
                if not diag:
                    return True
                try:          # diagnostics: finished flag, or no new step for 60 s (the page crashed)
                    return json.load(open(target, encoding="utf-8")).get("finished") or \
                        time.time() - os.path.getmtime(target) > 60
                except ValueError:
                    return False
            while not finished() and time.time() - t0 < a.timeout and p.poll() is None:
                time.sleep(1)
            wall = time.time() - t0
            time.sleep(1)
            subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)
            shutil.rmtree(profile, ignore_errors=True)
            if os.path.exists(target):
                m = json.load(open(target, encoding="utf-8"))
                m["wall_seconds_browser_start_to_result"] = round(wall, 1)
                json.dump(m, open(target, "w", encoding="utf-8"), indent=1)
                print(f"{full_tag}: done in {wall:.0f} s (load {m.get('load_seconds', 0):.1f} s, "
                      f"convert {m.get('convert_seconds', 0) or 0:.1f} s, error: {m.get('error')})", flush=True)
            else:
                print(f"{full_tag}: NO RESULT after {wall:.0f} s (browser exited: {p.poll() is not None})", flush=True)
    srv.shutdown()


if __name__ == "__main__":
    main()
