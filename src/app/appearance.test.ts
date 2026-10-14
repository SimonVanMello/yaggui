import { describe, expect, it } from 'vitest';

import { applyAppearance, fontScale, fontStack } from './appearance';

const base = {
  highContrast: false,
  density: 'comfortable',
  uiFont: null,
  codeFont: null,
  fontSize: 13,
} as const;

describe('fontStack', () => {
  it('quotes the family and keeps the bundled fonts as a fallback', () => {
    expect(fontStack('Helvetica Neue', 'system-ui')).toBe('"Helvetica Neue", system-ui');
  });
  it('returns null to keep the default', () => {
    expect(fontStack(null, 'x')).toBeNull();
    expect(fontStack('  ', 'x')).toBeNull();
  });
  it('cannot be used to close the declaration', () => {
    expect(fontStack('A"; color: red', 'x')).toBe('"A color: red", x');
  });
});

describe('fontScale', () => {
  it('is relative to the 13px default', () => {
    expect(fontScale(13)).toBe(1);
    expect(fontScale(16)).toBe(1.231);
    expect(fontScale(11)).toBe(0.846);
  });
});

describe('applyAppearance', () => {
  it('sets density, contrast, fonts and scale on the element', () => {
    const root = document.createElement('html');
    applyAppearance(
      { ...base, density: 'compact', highContrast: true, uiFont: 'Avenir', fontSize: 16 },
      root,
    );
    expect(root.dataset.density).toBe('compact');
    expect(root.dataset.contrast).toBe('high');
    expect(root.style.getPropertyValue('--font-ui')).toMatch(/^"Avenir", /);
    expect(root.style.getPropertyValue('--font-code')).toBe('');
    expect(root.style.getPropertyValue('--font-scale')).toBe('1.231');
  });

  it('puts everything back to the defaults', () => {
    const root = document.createElement('html');
    applyAppearance(
      { ...base, density: 'compact', highContrast: true, codeFont: 'Menlo', fontSize: 17 },
      root,
    );
    applyAppearance(base, root);
    expect(root.dataset.density).toBe('comfortable');
    expect(root.dataset.contrast).toBeUndefined();
    expect(root.style.getPropertyValue('--font-code')).toBe('');
    expect(root.style.getPropertyValue('--font-scale')).toBe('');
  });
});
