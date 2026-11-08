import { afterEach, describe, expect, it } from 'vitest';

import { currentPreferences, savePreferences } from '../../app/preferences';
import { DEFAULT_ZOOM, resetZoom, stepZoom, watchZoom, ZOOM_LEVELS, zoomIn, zoomOut } from './zoom';

const cssZoom = () => document.documentElement.style.getPropertyValue('zoom');

afterEach(() => {
  savePreferences({ zoom: DEFAULT_ZOOM });
});

describe('zoom levels', () => {
  it('are the steps of the brief, within the backend range', () => {
    expect(ZOOM_LEVELS).toEqual([80, 90, 100, 110, 125, 150]);
  });

  it('step to the next level, and stay at either end', () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(110, 1)).toBe(125);
    expect(stepZoom(150, 1)).toBe(150);
    expect(stepZoom(100, -1)).toBe(90);
    expect(stepZoom(80, -1)).toBe(80);
    // A value set by hand between two levels goes to the nearest one in that direction.
    expect(stepZoom(105, 1)).toBe(110);
    expect(stepZoom(105, -1)).toBe(100);
  });
});

describe('zoom commands', () => {
  it('save the level and apply it to the page', () => {
    const stop = watchZoom();
    zoomIn();
    expect(currentPreferences().zoom).toBe(110);
    expect(cssZoom()).toBe('1.1');
    zoomIn();
    zoomIn();
    expect(currentPreferences().zoom).toBe(150);
    zoomOut();
    expect(cssZoom()).toBe('1.25');
    resetZoom();
    expect(currentPreferences().zoom).toBe(100);
    // 100 % leaves no CSS zoom behind.
    expect(cssZoom()).toBe('');
    stop();
  });
});
