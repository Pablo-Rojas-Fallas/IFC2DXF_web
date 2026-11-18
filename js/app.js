// IFC2DXF web - page logic (main thread). The conversion itself runs in js/worker.js.
"use strict";

const APP_VERSION = "0.1.0";
const $ = (id) => document.getElementById(id);
const OPTION_IDS = ["axes_3d", "data_texts", "manholes_as_blocks", "layers_per_system", "declutter", "short_labels",
                    "write_geodata", "text_height", "data_text_scale"];

let worker = null, ready = false, busy = false, defaults = null, versions = null;
let file = null;            // the chosen IFC (File)
let ai = null;              // {name, bytes} of the loaded AI response, re-sent after a restart
let pending = null;         // action requested before the converter was ready
let running = null;         // command the user is waiting for: "prompt" | "loadAI" | "convert"
const blobUrls = [];

// ------------------------------------------------------------------ helpers
const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";
function setStatus(msg) { $("status").textContent = msg; }
function setEngine(state, msg) {
  const chip = $("engine");
  chip.classList.toggle("ready", state === "ready");
  chip.classList.toggle("failed", state === "failed");
  chip.querySelector(".i").className = "i " + (state === "ready" ? "i-ok" : state === "failed" ? "i-bad" : "i-loader spin");
  $("engine-text").textContent = msg;
}
function updateButtons() {
  const canUse = !!file && !busy;
  $("convert").disabled = !canUse;
  $("copy-prompt").disabled = !canUse;
  $("ai-input").disabled = busy;
  $("ai-label").setAttribute("aria-disabled", String(busy));
  $("cancel").disabled = !busy;
  $("ai-remove").disabled = busy;
  $("file-input").disabled = busy;
  $("drop").classList.toggle("locked", busy);
}
function setBusy(b) {
  busy = b;
  if (!b) running = null;
  $("run-card").setAttribute("aria-busy", String(b));
  updateButtons();
}
function icon(name) { const s = document.createElement("span"); s.className = "i i-" + name; s.setAttribute("aria-hidden", "true"); return s; }

// ------------------------------------------------------------------ worker
function startWorker() {
  ready = false;
  setEngine("loading", "Preparing the converter… (first visit: about 36 MB)");
  worker = new Worker("js/worker.js");
  worker.onmessage = (ev) => onMessage(ev.data);
  worker.onerror = (ev) => { setEngine("failed", "The converter could not start"); setStatus("Error: " + ev.message); setBusy(false); };
  worker.postMessage({ cmd: "init" });
}

async function sendFile() {
  const buffer = await file.arrayBuffer();
  worker.postMessage({ cmd: "setFile", name: file.name, buffer }, [buffer]);
}
function sendAI() {
  const copy = ai.bytes.slice(0);
  worker.postMessage({ cmd: "loadAI", name: ai.name, buffer: copy.buffer }, [copy.buffer]);
}

function onMessage(m) {
  switch (m.type) {
    case "loading": setEngine("loading", m.msg); break;
    case "ready": {
      ready = true; defaults = m.defaults; versions = m.versions;
      setEngine("ready", "Converter ready");
      if (!$("o-data_texts").dataset.init) applyOptions(defaults);
      (async () => {
        if (file) await sendFile();
        if (ai) sendAI();
        if (pending) { const p = pending; pending = null; p(); }
      })();
      break;
    }
    case "fileSet": break;
    case "progress":
      if (m.frac != null) $("bar").value = Math.round(m.frac * 100);
      else $("bar").removeAttribute("value");
      setStatus(m.msg);
      break;
    case "prompt": onPrompt(m.text); break;
    case "ai":
      if (running === "loadAI") { setBusy(false); onAI(m); }   // re-sent silently after a restart: no message
      break;
    case "aiCleared": break;
    case "done": onDone(m); break;
    case "error":
      setBusy(false); $("bar").value = 0;
      if (m.cmd === "init") setEngine("failed", "The converter could not start");
      setStatus("Error: " + m.msg);
      break;
  }
}

// run an action now, or as soon as the converter is ready
function whenReady(action, waitingMsg) {
  if (ready) return action();
  pending = action;
  setBusy(true);
  setStatus(waitingMsg + " It will start as soon as the converter is ready.");
}

// ------------------------------------------------------------------ 1. IFC
async function pickFile(f) {
  if (!f) return;
  if (!/\.ifc$/i.test(f.name)) { setStatus(`"${f.name}" is not an .ifc file.`); return; }
  file = f;
  $("file-name").textContent = `${f.name} – ${mb(f.size)}`;
  $("file-info").hidden = false;
  $("out-name").value = f.name.replace(/\.ifc$/i, "") + ".dxf";
  $("result").hidden = true; $("bar").value = 0;
  setStatus("IFC selected. Optionally run the AI analysis, check the options and press Convert to DXF.");
  updateButtons();
  if (ready) await sendFile();
}

// ------------------------------------------------------------------ 2. AI
function copyPrompt() {
  whenReady(() => {
    setBusy(true); running = "prompt"; $("prompt-box").hidden = true;
    setStatus("Reading the IFC to build the prompt…");
    worker.postMessage({ cmd: "prompt", name: file.name });
  }, "Preparing the prompt.");
}
async function onPrompt(text) {
  setBusy(false); $("bar").value = 0;
  $("prompt-text").value = text;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Prompt copied (${text.length.toLocaleString("en")} characters). Paste it into the Claude chat and send it.`);
  } catch (e) {
    $("prompt-box").hidden = false;
    $("prompt-text").focus(); $("prompt-text").select();
    setStatus("The prompt is ready below. Copy it and paste it into the Claude chat.");
  }
}
async function loadAI(f) {
  if (!f) return;
  ai = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
  whenReady(() => { setBusy(true); running = "loadAI"; setStatus("Reading the AI response…"); sendAI(); },
            "Reading the AI response.");
}
function onAI(m) {
  $("ai-reading").textContent = m.reading;
  $("ai-details").hidden = false;
  if (!m.usable) {
    ai = null;
    $("ai-state").textContent = `Could not use ${m.name} (${m.status}) – automatic mode. The reason is shown below.`;
    $("ai-remove").hidden = true;
    setStatus("The AI response could not be used; the converter will work in automatic mode.");
    return;
  }
  const st = m.status === "ok" ? "read correctly" : `read with ${m.repaired} automatic repair${m.repaired !== 1 ? "s" : ""}`;
  $("ai-state").textContent = `Loaded: ${m.name} – ${st}, ${m.ignored} item${m.ignored !== 1 ? "s" : ""} discarded. ` +
    "It will be cross-checked against the IFC during conversion.";
  $("ai-remove").hidden = false;
  const changes = [];     // pre-tick the options the AI recommends; the user can still change them
  if (m.axis_mode === "2D" || m.axis_mode === "3D") { $("o-axes_3d").checked = m.axis_mode === "3D"; changes.push(`axes ${m.axis_mode}`); }
  if (m.layers === "per_system" || m.layers === "single") {
    $("o-layers_per_system").checked = m.layers === "per_system";
    changes.push(m.layers === "per_system" ? "layers per system" : "single set of layers");
  }
  setStatus("AI analysis loaded." + (changes.length ? ` Options set from its recommendations: ${changes.join(", ")}.` : "") +
            (m.notes ? ` AI notes: ${m.notes}` : ""));
}
function removeAI() {
  ai = null;
  if (ready) worker.postMessage({ cmd: "clearAI" });
  $("ai-state").textContent = "No AI analysis loaded – automatic mode.";
  $("ai-remove").hidden = true; $("ai-details").hidden = true; $("ai-input").value = "";
  setStatus("AI analysis removed: automatic mode.");
}

// ------------------------------------------------------------------ 3. options
function applyOptions(d) {
  for (const k of OPTION_IDS) {
    const el = $("o-" + k);
    if (el.type === "checkbox") el.checked = !!d[k];
    else el.value = [...el.options].find((o) => Number(o.value) === Number(d[k]))?.value ?? el.options[0].value;
  }
  $("o-data_texts").dataset.init = "1";
}
function readOptions() {
  const o = { overwrite: true };    // the browser always writes into its own empty temporary folder
  for (const k of OPTION_IDS) {
    const el = $("o-" + k);
    o[k] = el.type === "checkbox" ? el.checked : Number(el.value);
  }
  return o;
}
function outName() {
  let n = ($("out-name").value || "").trim().replace(/[\\/:*?"<>|]+/g, "_");
  if (!n) n = file.name.replace(/\.ifc$/i, "");
  if (!/\.dxf$/i.test(n)) n += ".dxf";
  $("out-name").value = n;
  return n;
}

// ------------------------------------------------------------------ 4. convert
function convert() {
  const options = readOptions(), name = outName();
  whenReady(() => {
    setBusy(true); running = "convert"; $("result").hidden = true; $("bar").value = 0;
    setStatus("Converting…");
    worker.postMessage({ cmd: "convert", name: file.name, outName: name, options });
  }, "Conversion requested.");
}
function cancel() {
  worker.terminate();
  pending = null;
  setBusy(false); $("bar").value = 0;
  setStatus("Cancelled. No DXF was written. Restarting the converter…");
  startWorker();
}

function onDone(m) {
  setBusy(false);
  for (const u of blobUrls.splice(0)) URL.revokeObjectURL(u);
  const r = m.result;
  if (!r.ok) {
    $("bar").value = 0;
    setStatus("The conversion failed: " + r.error);
    return;
  }
  $("bar").value = 100;
  const ew = $("engine-warning"); ew.replaceChildren();
  ew.hidden = !r.context_offset;
  if (r.context_offset) {   // known limitation of the browser engine (see py/CHANGES.md)
    const txt = document.createElement("span");
    txt.append(document.createTextNode("Check this drawing: pipe and manhole outlines may be misplaced."));
    const small = document.createElement("small");
    small.textContent = `This IFC places its model at a shifted origin (X ${r.context_offset[0].toLocaleString("en")}, ` +
      `Y ${r.context_offset[1].toLocaleString("en")}). The browser version cannot yet handle this reliably: compare ` +
      "the outlines with the axes, or convert this file with the IFC2DXF desktop app.";
    txt.append(small);
    ew.append(icon("warn"), txt);
  }
  renderBadge(r.georef);
  renderSummary(r, m.seconds);
  const dl = $("downloads"); dl.replaceChildren();
  for (const [name, bytes] of Object.entries(m.files)) {
    const isDxf = /\.dxf$/i.test(name);
    const url = URL.createObjectURL(new Blob([bytes], { type: isDxf ? "application/dxf" : "text/plain" }));
    blobUrls.push(url);
    const a = document.createElement("a");
    a.className = "btn " + (isDxf ? "primary" : "secondary");
    a.href = url; a.download = name;
    a.append(icon("download"), document.createTextNode(isDxf ? `Download DXF (${name})` : `Download ${name}`));
    dl.append(a);
  }
  $("report").textContent = r.report;
  $("result").hidden = false;
  const miss = r.missing.length ? ` Warning: ${r.missing.length} element(s) missing or drawn from their axis only.` : "";
  setStatus(`Done in ${m.seconds.toFixed(0)} s. The DXF is ready to download.` + miss);
  $("result").focus();
}

function renderBadge(g) {
  const b = $("badge"); b.replaceChildren(); b.className = "badge";
  let cls, ic, title, note;
  if (!g) {
    cls = "bad"; ic = "bad"; title = "Georeferencing could not be checked.";
    note = "See the report for details.";
  } else if (g.assured && g.confidence === "high") {
    cls = "ok"; ic = "ok"; title = `Georeferenced: ${g.crs_name || "EPSG:" + g.epsg} (EPSG:${g.epsg})`;
    note = `The coordinates are real map coordinates. In AutoCAD assign ${g.autodesk || "EPSG:" + g.epsg} without ` +
           "moving or scaling anything. A .prj file is included.";
  } else if (g.assured) {
    cls = "warn"; ic = "warn"; title = `Probably georeferenced: ${g.crs_name || ""} (EPSG:${g.epsg}), confidence ${g.confidence}`;
    note = "Check the georeferencing section and the warnings of the report before using the drawing.";
  } else {
    cls = "bad"; ic = "bad"; title = "Not georeferenced: the DXF keeps the local coordinates of the IFC.";
    note = "The IFC did not confirm real map coordinates, so no .prj file was written.";
  }
  b.classList.add(cls);
  const txt = document.createElement("span");
  txt.append(document.createTextNode(title));
  const small = document.createElement("small"); small.textContent = note; txt.append(small);
  b.append(icon(ic), txt);
}

function renderSummary(r, seconds) {
  const ul = $("summary"); ul.replaceChildren();
  const li = (text, warn) => { const e = document.createElement("li"); e.textContent = text; if (warn) e.className = "warnline"; ul.append(e); };
  const k = r.kinds || {};
  const names = { pipe: "pipes", manhole: "manholes", accessory: "accessories", unclassified: "unclassified elements" };
  const parts = Object.entries(names).filter(([key]) => k[key]).map(([key, n]) => `${k[key]} ${n}`);
  li("Converted: " + (parts.join(", ") || "nothing") + ".");
  const lp = r.label_placement;
  if (lp) {
    li(`Labels: ${lp.n} placed – kept ${lp.stayed}, moved ${lp.moved}, with a leader line ${lp.leader}, ` +
       `not resolved ${lp.unresolved}.`, lp.unresolved > 0);
    if (lp.skipped) li(`Label placement stopped after ${lp.budget} s: ${lp.skipped} texts left at their original ` +
                       "position (they may overlap). Try a smaller data text size or short pipe labels.", true);
  } else if (r.data_texts) li("Label placement: off.");
  else li("Data texts: off.");
  if (r.missing.length) {
    li(`${r.missing.length} element(s) missing from the DXF or drawn from their axis only (no 3D body in the IFC):`, true);
    for (const [what, who] of r.missing.slice(0, 10)) li(`${who}: ${what}`, true);
    if (r.missing.length > 10) li(`… and ${r.missing.length - 10} more – see MISSING DATA in the report.`, true);
  }
  if (r.recovered) li(`${r.recovered} element(s) needed a geometry retry and were drawn normally.`);
  li(r.warnings ? `${r.warnings} warning(s): read them in the report below.` : "No warnings.", r.warnings > 0);
  li(`Time: ${seconds.toFixed(0)} s.`);
}

// ------------------------------------------------------------------ theme
function currentTheme() {
  return document.documentElement.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function showThemeButton() {
  const dark = currentTheme() === "dark";
  const btn = $("theme");
  btn.setAttribute("aria-pressed", String(dark));
  btn.querySelector(".i").className = "i " + (dark ? "i-sun" : "i-moon");
  btn.querySelector(".sr-only").textContent = "Dark mode";
  btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
}
$("theme").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("ifc2dxf-theme", next); } catch (e) { /* not stored: fine */ }
  showThemeButton();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", showThemeButton);

// ------------------------------------------------------------------ wiring
$("file-input").addEventListener("change", (e) => pickFile(e.target.files[0]));
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); pickFile(e.dataTransfer.files[0]); });
document.addEventListener("dragover", (e) => e.preventDefault());           // a drop outside the zone must not open the file
document.addEventListener("drop", (e) => { if (!drop.contains(e.target)) e.preventDefault(); });
$("copy-prompt").addEventListener("click", copyPrompt);
$("prompt-copy-again").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("prompt-text").value); setStatus("Prompt copied."); }
  catch (e) { $("prompt-text").select(); setStatus("Press Ctrl+C to copy the selected prompt."); }
});
$("ai-input").addEventListener("change", (e) => loadAI(e.target.files[0]));
$("ai-remove").addEventListener("click", removeAI);
$("reset-options").addEventListener("click", () => { if (defaults) { applyOptions(defaults); setStatus("Options restored to the defaults."); } });
$("convert").addEventListener("click", convert);
$("cancel").addEventListener("click", cancel);
// the Claude logo is shown only if the site owner placed assets/claude.png; otherwise the chat icon stays
const logo = $("claude-logo");
logo.addEventListener("load", () => { logo.hidden = false; $("claude-fallback").hidden = true; });
logo.addEventListener("error", () => { logo.remove(); });
if (logo.complete && logo.naturalWidth) { logo.hidden = false; $("claude-fallback").hidden = true; }

$("app-version").textContent = APP_VERSION;
showThemeButton();
updateButtons();
startWorker();
