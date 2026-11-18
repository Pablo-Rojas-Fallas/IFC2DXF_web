// Applies the saved light/dark choice before the page is drawn (no flash). Without a saved choice the system
// setting (prefers-color-scheme) is used. Only this preference is stored in the browser, nothing else.
"use strict";
(function () {
  let t = null;
  try { t = localStorage.getItem("ifc2dxf-theme"); } catch (e) { /* storage blocked: follow the system */ }
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
})();
