// Applied before first paint so there's no flash of the wrong theme.
(function () {
  var t = "system", a = "blue";
  try { t = localStorage.getItem("cv_theme") || t; a = localStorage.getItem("cv_accent") || a; } catch (e) {}
  if (t !== "system") document.documentElement.setAttribute("data-theme", t);
  document.documentElement.setAttribute("data-accent", a);
})();
