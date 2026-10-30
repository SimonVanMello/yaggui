// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const capabilities = JSON.parse(
  readFileSync(new URL('../../src-tauri/capabilities/default.json', import.meta.url), 'utf8'),
) as { permissions: string[] };

describe('window capabilities', () => {
  // Tauri cancels the native close as soon as a close-requested listener exists and leaves it
  // to the webview's `destroy()`: a missing permission leaves a window that cannot be closed.
  it('lets the webview destroy the window after its close-requested handler', () => {
    expect(capabilities.permissions).toContain('core:window:allow-destroy');
  });
});
