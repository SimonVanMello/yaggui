// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { patchXterm } from '../../../vite/xtermCsp';

const require = createRequire(import.meta.url);
const xterm = readFileSync(
  require.resolve('@xterm/xterm/lib/xterm.mjs', { paths: [process.cwd()] }),
  'utf8',
);

describe('xterm CSP patch', () => {
  it('leaves no inline style attribute and no <style> without the nonce', () => {
    const patched = patchXterm(xterm);
    expect(patched).not.toContain('setAttribute("style"');
    expect(patched.match(/__yagguiCspStyle\(/g)).toHaveLength(4);
    // The only one left is in the helper, which sets the nonce.
    expect(patched.match(/\.createElement\("style"\)/g)).toHaveLength(1);
  });

  it('fails loudly on another xterm build', () => {
    expect(() => patchXterm('export const x = 1;')).toThrow(/xterm CSP patch/);
  });
});
