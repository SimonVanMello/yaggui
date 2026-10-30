// Applies the cached theme before the first paint, to avoid a light flash in dark mode.
// Mirrors resolveTheme() in src/theme/themeStore.ts; cache keys in src/app/preferences.ts.
(function () {
  var preference = 'system';
  var style = 'standard';
  var lightTheme = null;
  var darkTheme = null;
  try {
    preference = localStorage.getItem('yaggui.themeCache') || 'system';
    style = localStorage.getItem('yaggui.styleCache') || 'standard';
    lightTheme = localStorage.getItem('yaggui.lightThemeCache');
    darkTheme = localStorage.getItem('yaggui.darkThemeCache');
  } catch (_) {
    // Storage unavailable: follow the OS.
  }
  // Cached before the color themes: the Terminal style brought its own dark colors.
  if (style === 'terminal' && darkTheme === null) {
    darkTheme = 'terminal';
    preference = 'dark';
  }
  var dark =
    preference === 'dark' ||
    (preference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  // An id the app does not know falls back to the default once it has loaded.
  root.dataset.theme = (dark ? darkTheme : lightTheme) || (dark ? 'graphite' : 'paper');
  if (style === 'terminal') root.dataset.style = 'terminal';
})();
