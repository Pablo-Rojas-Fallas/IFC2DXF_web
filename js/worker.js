// IFC2DXF web - Web Worker. Runs Python (Pyodide, WebAssembly) and the ifc2dxf package off the main thread, so the
// page stays responsive. Everything is loaded from this site; nothing is sent anywhere.
"use strict";

const ROOT = new URL("../", self.location).href;
importScripts(ROOT + "vendor/pyodide/pyodide.js");

const PYODIDE_PACKAGES = ["numpy", "shapely", "pyproj", "micropip", "packaging", "pyparsing", "typing-extensions",
                          "fonttools", "python-dateutil"];
const EXTRA_WHEELS = ["ifcopenshell-0.8.5-cp313-cp313-pyodide_2025_0_wasm32.whl", "ezdxf-1.4.5-py3-none-any.whl",
                      "json_repair-0.64.9-py3-none-any.whl", "isodate-0.7.2-py3-none-any.whl",
                      "lark-1.3.1-py3-none-any.whl"];
const PY_FILES = ["__init__.py", "analysis.py", "classify.py", "dxf_writer.py", "geometry.py", "georef.py",
                  "ifc_reader.py", "label_layout.py", "pipeline.py", "prompt.py", "report.py", "schema.py",
                  "summary.py"];

// Python glue between the page and the unchanged ifc2dxf package.
const GLUE = `
import json, os, dataclasses, collections
import importlib.metadata as md
import sys
sys.path.insert(0, "/home/pyodide")
from ifc2dxf import __version__ as ENGINE_VERSION
from ifc2dxf import analysis as an
from ifc2dxf import georef as gr
from ifc2dxf.pipeline import Options, convert as _convert
from ifc2dxf.prompt import build as _build_prompt
from ifc2dxf.report import report_text
from ifc2dxf.summary import generate as _summary

ANALYSIS = None
WORK = "/work"

import re
def web_context_offset(path):
    """Origin (x, y) of the 3D model context's WorldCoordinateSystem, read from the IFC text, or None when it is
    0, 0. Known limitation of the browser engine (IfcOpenShell 0.8.5): with a shifted context (e.g. IFCs re-saved
    by Bonsai with a false origin) the 3D bodies can be misplaced, while the desktop app handles them correctly."""
    with open(path, "rb") as fh:
        txt = fh.read().decode("latin-1")
    for m in re.finditer(r"=\\s*IFCGEOMETRICREPRESENTATIONCONTEXT\\s*\\(([^;]*)\\);", txt, re.I):
        refs = re.findall(r"#(\\d+)", m.group(1))
        if not refs:
            continue
        a = re.search(r"#%s\\s*=\\s*IFCAXIS2PLACEMENT3D\\s*\\(\\s*#(\\d+)" % refs[0], txt, re.I)
        p = a and re.search(r"#%s\\s*=\\s*IFCCARTESIANPOINT\\s*\\(\\s*\\(([^)]*)\\)" % a.group(1), txt, re.I)
        if p:
            xy = [float(v) for v in p.group(1).split(",")[:2]]
            if abs(xy[0]) > 1e-6 or abs(xy[1]) > 1e-6:
                return xy
    return None

def web_info():
    import numpy, shapely, pyproj, ezdxf
    return json.dumps({
        "defaults": dataclasses.asdict(Options()),
        "versions": {"ifc2dxf": ENGINE_VERSION, "Python": sys.version.split()[0],
                     "IfcOpenShell": md.version("ifcopenshell"), "ezdxf": ezdxf.__version__,
                     "shapely": shapely.__version__, "GEOS": shapely.geos_version_string,
                     "numpy": numpy.__version__, "pyproj": pyproj.__version__, "PROJ": pyproj.proj_version_str,
                     "json-repair": md.version("json_repair")}})

def web_prompt(path, progress):
    return _build_prompt(_summary(path, progress=lambda f, m: progress(m)))

def web_load_ai(path):
    global ANALYSIS
    a = an.read(path)            # never raises
    rec = a.data.get("recommendations") if (a.usable and isinstance(a.data, dict)) else None
    ANALYSIS = a if a.usable else None
    return json.dumps({"usable": a.usable, "status": a.status, "repaired": len(a.repaired), "ignored": len(a.ignored),
                       "reading": an.reading_text(a),
                       "axis_mode": rec.get("axis_mode") if rec else None,
                       "layers": rec.get("layers") if rec else None,
                       "notes": rec.get("notes") if rec else None})

def web_clear_ai():
    global ANALYSIS
    ANALYSIS = None

def web_convert(ifc_path, dxf_path, options_json, progress):
    opts = json.loads(options_json)
    known = {f.name for f in dataclasses.fields(Options)}
    r = _convert(ifc_path, dxf_path, Options(**{k: v for k, v in opts.items() if k in known}),
                 analysis=ANALYSIS, progress=lambda f, m: progress(f, m))
    rep = r.report
    out = {"ok": r.ok, "error": r.error}
    if not r.ok:
        out["report"] = rep.get("traceback", "")
        return json.dumps(out, default=str)
    g = rep.get("georef")
    kinds = collections.Counter()
    for (system, kind), n in (rep.get("converted") or {}).items():
        kinds[kind] += n
    lp = rep.get("label_placement") or {}
    out.update({
        "context_offset": web_context_offset(ifc_path),
        "files": [os.path.basename(p) for p in [r.dxf_path, *r.extra_paths]],
        "report": report_text(rep) + ("\\n\\n" + an.reading_text(ANALYSIS) if ANALYSIS is not None else ""),
        "georef": None if g is None else {
            "assured": bool(g.assured), "method": g.method, "epsg": g.epsg, "confidence": g.confidence,
            "crs_name": getattr(g, "crs_name", None),
            "autodesk": (gr.autodesk_cs_code(g.epsg) if g.assured and g.epsg else None)},
        "kinds": dict(kinds),
        "label_placement": {k: lp.get(k) for k in ("n", "stayed", "moved", "leader", "unresolved", "skipped",
                                                   "budget", "after")} if lp else None,
        "data_texts": opts.get("data_texts", True),
        "warnings": len(rep.get("warnings", [])),
        "missing": [list(x) for x in rep.get("missing_elements", []) if not x[0].startswith("recovered")],
        "recovered": sum(1 for x in rep.get("missing_elements", []) if x[0].startswith("recovered")),
    })
    return json.dumps(out, default=str)
`;

let py = null;
let glue = null;
const post = (type, data, transfer) => postMessage(Object.assign({ type }, data || {}), transfer || []);
const errText = (e) => String(e && e.message ? e.message : e);

async function init() {
  post("loading", { msg: "Loading Python…" });
  py = await loadPyodide({ indexURL: ROOT + "vendor/pyodide/" });
  post("loading", { msg: "Loading the geometry libraries…" });
  await py.loadPackage(PYODIDE_PACKAGES, { messageCallback: () => {} });
  await py.loadPackage(EXTRA_WHEELS.map((f) => ROOT + "vendor/wheels/" + f), { messageCallback: () => {} });
  post("loading", { msg: "Loading the converter…" });
  py.FS.mkdirTree("/home/pyodide/ifc2dxf");
  py.FS.mkdirTree("/work");
  for (const f of PY_FILES) {
    const r = await fetch(ROOT + "py/ifc2dxf/" + f);
    if (!r.ok) throw new Error("Cannot load py/ifc2dxf/" + f);
    py.FS.writeFile("/home/pyodide/ifc2dxf/" + f, await r.text());
  }
  py.runPython(GLUE);
  glue = py.globals;
  const info = JSON.parse(glue.get("web_info")());
  post("ready", info);
}

function clearWork(keep) {
  for (const f of py.FS.readdir("/work")) {
    if (f !== "." && f !== ".." && !keep.includes(f)) py.FS.unlink("/work/" + f);
  }
}

const handlers = {
  async setFile(m) {          // the IFC is kept in the worker's memory file system until another file is chosen
    clearWork(["ai.json"]);
    py.FS.writeFile("/work/" + m.name, new Uint8Array(m.buffer));
    post("fileSet", { name: m.name });
  },
  async prompt(m) {
    const text = glue.get("web_prompt")("/work/" + m.name, (msg) => post("progress", { frac: null, msg }));
    post("prompt", { text });
  },
  async loadAI(m) {
    py.FS.writeFile("/work/ai.json", new Uint8Array(m.buffer));
    post("ai", Object.assign({ name: m.name }, JSON.parse(glue.get("web_load_ai")("/work/ai.json"))));
  },
  async clearAI() {
    glue.get("web_clear_ai")();
    post("aiCleared");
  },
  async convert(m) {
    const t0 = performance.now();
    const dxf = "/work/" + m.outName;
    const res = JSON.parse(glue.get("web_convert")("/work/" + m.name, dxf, JSON.stringify(m.options),
                                                   (frac, msg) => post("progress", { frac, msg })));
    const files = {};
    if (res.ok) {
      for (const f of res.files) {
        files[f] = py.FS.readFile("/work/" + f);
        py.FS.unlink("/work/" + f);           // outputs are handed to the page; the worker keeps only the IFC
      }
    }
    post("done", { result: res, files, seconds: (performance.now() - t0) / 1000 },
         Object.values(files).map((b) => b.buffer));
  },
};

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.cmd === "init") await init();
    else await handlers[m.cmd](m);
  } catch (e) {
    post("error", { cmd: m.cmd, msg: errText(e) });
  }
};
