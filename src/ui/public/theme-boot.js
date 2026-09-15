/**
 * Applies the stored theme before first paint, so the correct one never flashes.
 *
 * This is a real file rather than an inline <script> so the shell can be served under
 * a Content-Security-Policy with no 'unsafe-inline' — see src/server/static.ts.
 * It must stay render-blocking, and it must stay tiny.
 */
try {
  var stored = localStorage.getItem('packui:theme')
  if (stored) document.documentElement.dataset.theme = stored
} catch (_error) {
  // Private mode, or storage is blocked. The default theme is correct then.
}
