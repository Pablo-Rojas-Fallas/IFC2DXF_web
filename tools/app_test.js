// TEST ONLY: drives the real app (../index.html, same origin) like a user and posts the results to the local test
// server (tools/phase0_measure.py --root --page tools/app_test.html). Parameters: auto=<IFC url>&ai=<json url>
// &tag=<t>&post=<url>&opts=<JSON of options to change>&cancel=1 (also test Cancel)
"use strict";
const P = new URLSearchParams(location.search);
const out = { checks: [], started: new Date().toISOString(), user_agent: navigator.userAgent };
const logEl = document.getElementById("log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = performance.now();
const t = () => +((performance.now() - T0) / 1000).toFixed(1);

function check(name, ok, detail) {
  out.checks.push({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail).slice(0, 600), t: t() });
  logEl.textContent = out.checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.name}  ${c.detail}`).join("\n");
}
async function waitFor(fn, timeoutS, every = 250) {
  const end = performance.now() + timeoutS * 1000;
  while (performance.now() < end) { try { const v = fn(); if (v) return v; } catch (e) { /* not yet */ } await sleep(every); }
  return null;
}
async function postFile(name, body) {
  const post = P.get("post"), tag = P.get("tag") || "app";
  await fetch(`${post}/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`, { method: "POST", body });
}
function setInputFile(doc, input, file) {     // objects created in the app frame's own context
  const win = doc.defaultView;
  const dt = new win.DataTransfer(); dt.items.add(new win.File([file], file.name)); input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function run() {
  const frame = document.getElementById("app");
  await waitFor(() => frame.contentDocument && frame.contentDocument.getElementById("app-version") &&
                      frame.contentDocument.getElementById("app-version").textContent, 30);
  const w = frame.contentWindow, d = frame.contentDocument, $ = (id) => d.getElementById(id);

  // page basics
  check("page title", d.title.startsWith("IFC2DXF"), d.title);
  check("footer: files never leave the computer", d.body.textContent.includes("Your files never leave your computer"));
  check("footer: version shown", /\d+\.\d+\.\d+/.test($("app-version").textContent), $("app-version").textContent);
  check("licences link", !!d.querySelector('a[href="licences.html"]'));
  check("Open Claude link", $("open-claude").href === "https://claude.ai/login" && $("open-claude").target === "_blank");
  check("Claude logo: fallback icon shown when assets/claude.png is missing",
        await waitFor(() => !d.getElementById("claude-logo") || !$("claude-fallback").hidden, 5) !== null,
        d.getElementById("claude-logo") ? "logo present" : "fallback icon");
  check("buttons disabled before a file is chosen", $("convert").disabled && $("copy-prompt").disabled);

  // converter loads in the background
  const tReady = await waitFor(() => $("engine").classList.contains("ready") && t(), 180);
  check("converter ready (background loading)", tReady, `${tReady} s`);
  check("defaults applied (data texts on, declutter on, geodata off, text height 0.5)",
        $("o-data_texts").checked && $("o-declutter").checked && !$("o-write_geodata").checked && $("o-text_height").value === "0.5");

  // theme toggle
  const before = d.documentElement.dataset.theme || "system";
  $("theme").click();
  check("theme toggle", (d.documentElement.dataset.theme || "system") !== before && $("theme").getAttribute("aria-pressed") !== null,
        `${before} -> ${d.documentElement.dataset.theme}`);
  $("theme").click();

  // 1. IFC
  const ifcUrl = P.get("auto");
  const name = decodeURIComponent(ifcUrl.split("/").pop());
  const blob = await (await fetch(ifcUrl)).blob();
  setInputFile(d, $("file-input"), new File([blob], name));
  check("file chosen -> name shown, buttons enabled",
        await waitFor(() => !$("file-info").hidden && !$("convert").disabled, 10), $("file-name").textContent);
  check("default DXF name", $("out-name").value === name.replace(/\.ifc$/i, "") + ".dxf", $("out-name").value);
  await sleep(500);

  // 2. AI: copy prompt
  $("copy-prompt").click();
  const pr = await waitFor(() => ($("status").textContent.startsWith("Prompt copied") || !$("prompt-box").hidden) && $("prompt-text").value, 300);
  check("Copy prompt builds the prompt", pr && pr.startsWith("You are a specialist") && pr.includes("=== END OF SUMMARY ==="),
        `${(pr || "").length} characters; ${$("prompt-box").hidden ? "copied to clipboard" : "shown in the text box (clipboard blocked)"}`);
  // 2. AI: load response
  if (P.get("ai")) {
    const aiBlob = await (await fetch(P.get("ai"))).blob();
    setInputFile(d, $("ai-input"), new File([aiBlob], decodeURIComponent(P.get("ai").split("/").pop())));
    const st = await waitFor(() => $("ai-state").textContent.startsWith("Loaded:") && $("ai-state").textContent, 60);
    check("Load AI response", st, st || $("ai-state").textContent);
    check("AI reading shown", !$("ai-details").hidden && $("ai-reading").textContent.length > 50);
  }

  // 3. options from the test parameters
  const opts = JSON.parse(P.get("opts") || "{}");
  for (const [k, v] of Object.entries(opts)) {
    const el = $("o-" + k); if (!el) continue;
    if (el.type === "checkbox") el.checked = !!v; else el.value = String(v);
  }

  // 4. convert
  const t0 = t();
  $("convert").click();
  check("Cancel enabled while converting", await waitFor(() => !$("cancel").disabled, 5));
  const done = await waitFor(() => (!$("result").hidden || $("status").textContent.includes("failed")) && t(), 3600, 1000);
  out.convert_seconds = done ? +(done - t0).toFixed(1) : null;
  check("conversion finished", done && !$("result").hidden, $("status").textContent);
  if (!$("result").hidden) {
    const badge = $("badge");
    out.badge = { cls: badge.className, text: badge.textContent };
    check("georeference badge shown", /\b(ok|warn|bad)\b/.test(badge.className), badge.className + ": " + badge.textContent);
    out.summary = [...$("summary").querySelectorAll("li")].map((li) => li.textContent);
    check("result summary", out.summary.length >= 3, out.summary.join(" | "));
    const links = [...$("downloads").querySelectorAll("a")];
    out.downloads = links.map((a) => a.download);
    check("download buttons (DXF first)", links.length >= 2 && /\.dxf$/i.test(links[0].download), out.downloads.join(", "));
    for (const a of links) {
      const b = await (await fetch(a.href)).blob();
      await postFile(a.download.replace(/[^A-Za-z0-9._-]/g, "_"), b);
      check(`download works: ${a.download}`, b.size > 0, `${b.size} bytes`);
    }
    check("full report available", $("report").textContent.includes("CONVERSION REPORT"));
    check("focus moved to the result (screen readers)", d.activeElement === $("result"));
  }

  // cancel
  if (P.get("cancel")) {
    $("convert").click();
    await sleep(4000);
    $("cancel").click();
    check("Cancel stops the conversion", $("status").textContent.startsWith("Cancelled"), $("status").textContent);
    const back = await waitFor(() => $("engine").classList.contains("ready") && t(), 180);
    check("converter restarts after Cancel", back, `${back} s`);
    check("file still selected after Cancel", !$("convert").disabled);
  }

  out.passed = out.checks.filter((c) => c.ok).length;
  out.total = out.checks.length;
  await postFile("measure.json", JSON.stringify(out, null, 1));
}
run().catch(async (e) => { check("test script error", false, e && e.stack || e); await postFile("measure.json", JSON.stringify(out, null, 1)); });
