// Light/dark theme. Follows the system until the visitor picks one with the
// header button; the choice is remembered in this browser.
// Loaded in <head> so the saved theme applies before the first paint.
(() => {
  const root = document.documentElement;
  const media = matchMedia("(prefers-color-scheme: dark)");
  try {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") root.dataset.theme = saved;
  } catch (e) {}

  const isDark = () =>
    root.dataset.theme ? root.dataset.theme === "dark" : media.matches;
  window.siteTheme = { isDark };
  const announce = () => dispatchEvent(new Event("themechange"));
  // Colors cross-fade only while switching (class removed afterwards so
  // hover effects stay instant).
  let fadeTimer;
  const fade = () => {
    root.classList.add("theme-fading");
    void root.offsetWidth;
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => root.classList.remove("theme-fading"), 800);
  };
  media.addEventListener("change", () => {
    if (root.dataset.theme) return;
    fade();
    announce();
  });

  addEventListener("DOMContentLoaded", () => {
    const button = document.querySelector(".theme-toggle");
    if (!button) return;
    button.addEventListener("click", (e) => {
      e.stopPropagation(); // don't count as "skip typing"
      const next = isDark() ? "light" : "dark";
      fade();
      root.dataset.theme = next;
      try {
        localStorage.setItem("theme", next);
      } catch (err) {}
      announce();
    });
  });
})();
