// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { THEMES } from './catalog';

const THEME_DIR = dirname(fileURLToPath(import.meta.url));

type Tokens = Record<string, string>;

/** Declarations of the first block whose selector is exactly `selector`. */
function block(css: string, selector: string): Tokens {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return {};
  const end = css.indexOf('}', start);
  const body = css.slice(start + selector.length + 2, end);
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]),
  );
}

const CSS = ['graphite.css', 'paper.css', 'terminal.css', 'themes.generated.css']
  .map((file) => readFileSync(join(THEME_DIR, file), 'utf8'))
  .join('\n');

function themeTokens(name: string, high: boolean): Tokens {
  const base = block(CSS, `[data-theme='${name}']`);
  return high ? { ...base, ...block(CSS, `[data-theme='${name}'][data-contrast='high']`) } : base;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colors. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const SURFACES = ['--bg-app', '--bg-panel', '--bg-elevated', '--bg-hover', '--bg-selected'];
const TEXT = ['--fg-primary', '--fg-secondary', '--fg-muted'];
const STATUS = ['--accent', '--success', '--warning', '--danger', '--info'];
const NAMES = THEMES.map((theme) => theme.id);

describe('WCAG AA contrast of the themes', () => {
  for (const name of NAMES) {
    for (const high of [false, true]) {
      const label = `${name}${high ? ' (high contrast)' : ''}`;
      const t = themeTokens(name, high);
      const get = (token: string): string => {
        const value = t[token];
        expect(value, `${label}: ${token} is a #rrggbb color`).toMatch(/^#[0-9a-f]{6}$/i);
        return value ?? '#000000';
      };

      it(`${label}: text is at least ${high ? '7' : '4.5'}:1 on every surface`, () => {
        const min = high ? 7 : 4.5;
        for (const fg of TEXT) {
          for (const bg of SURFACES) {
            const ratio = contrast(get(fg), get(bg));
            expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
          }
        }
      });

      it(`${label}: accent and status colors are readable as text`, () => {
        for (const fg of STATUS) {
          for (const bg of ['--bg-app', '--bg-panel']) {
            const ratio = contrast(get(fg), get(bg));
            expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(high ? 4.5 : 4.5);
          }
        }
      });

      it(`${label}: text on accent and warning fills`, () => {
        expect(contrast(get('--accent-fg'), get('--accent'))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(get('--on-warning'), get('--warning'))).toBeGreaterThanOrEqual(4.5);
      });

      if (high) {
        it(`${label}: borders reach 3:1 against the panels (WCAG 1.4.11)`, () => {
          for (const border of ['--border-subtle', '--border-strong']) {
            for (const bg of ['--bg-app', '--bg-panel']) {
              expect(contrast(get(border), get(bg)), `${border} on ${bg}`).toBeGreaterThanOrEqual(
                3,
              );
            }
          }
        });
      }
    }
  }
});
