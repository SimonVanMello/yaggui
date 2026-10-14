import type { Plugin } from 'vite';

/**
 * Makes @xterm/xterm work under the production CSP (nonces, so no 'unsafe-inline'),
 * without weakening it. xterm has no nonce option (unlike CodeMirror's `cspNonce`):
 *
 * - the three <style> elements it creates (theme colors, cell size, scroll bar) get the
 *   page's style nonce, read like `styleNonce()` in `src/features/diff/editor.ts`;
 * - the one inline `style` attribute it sets (24-bit colors, minimum contrast) goes through
 *   the CSSOM instead, which the CSP does not restrict.
 *
 * Exact code of the pinned version: if an upgrade changes it, the build fails here rather
 * than shipping a terminal that loses its colors to CSP violations.
 */
export const XTERM_FILE = /[\\/]@xterm[\\/]xterm[\\/]lib[\\/]xterm\.mjs$/;

const STYLE_HELPER =
  'function __yagguiCspStyle(d){const s=d.createElement("style");' +
  'const n=d.querySelector("style[nonce]")?.nonce;if(n)s.nonce=n;return s}\n';

const ADD_STYLE = {
  from: '_addStyle(t,e){t.setAttribute("style",`${t.getAttribute("style")||""}${e};`)}',
  to: '_addStyle(t,e){t.style.cssText+=`${e};`}',
};

const CREATE_STYLE = /([\w$]+(?:\.[\w$]+)*)\.createElement\("style"\)/g;
const STYLE_ELEMENTS = 3;

export function patchXterm(code: string): string {
  if (!code.includes(ADD_STYLE.from)) {
    throw new Error('xterm CSP patch: `_addStyle` not found, check vite/xtermCsp.ts');
  }
  const created = code.match(CREATE_STYLE)?.length ?? 0;
  if (created !== STYLE_ELEMENTS) {
    throw new Error(
      `xterm CSP patch: expected ${String(STYLE_ELEMENTS)} <style> elements, found ${String(created)}`,
    );
  }
  return (
    STYLE_HELPER +
    code
      .replace(ADD_STYLE.from, ADD_STYLE.to)
      .replace(CREATE_STYLE, (_, document: string) => `__yagguiCspStyle(${document})`)
  );
}

export function xtermCsp(): Plugin {
  return {
    name: 'yaggui-xterm-csp',
    enforce: 'pre',
    transform(code, id) {
      if (!XTERM_FILE.test(id.split('?')[0] ?? id)) return null;
      return { code: patchXterm(code), map: null };
    },
  };
}
