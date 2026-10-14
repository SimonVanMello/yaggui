// Applies the cached theme before the first paint, to avoid a light flash in dark mode.
// Mirrors resolveTheme() in src/theme/themeStore.ts; THEME_CACHE_KEY in src/app/preferences.ts.
(function () {
  var preference = 'system';
  var style = 'standard';
  try {
    preference = localStorage.getItem('yaggui.themeCache') || 'system';
    style = localStorage.getItem('yaggui.styleCache') || 'standard';
  } catch (_) {
    // Storage unavailable: follow the OS.
  }
  var dark =
    preference === 'dark' ||
    (preference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme =
    style === 'terminal' ? 'terminal' : dark ? 'graphite' : 'paper';
})();
