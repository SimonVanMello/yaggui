import { useSyncExternalStore } from 'react';

import { currentPreferences, subscribePreferences } from '../../app/preferences';
import { nativeWindow, ZOOM_MAX, ZOOM_MIN } from '../../ipc';
import { savePreferenceOrToast } from '../preferences/savePreference';

/** The steps of Zoom in / Zoom out, in percent, within the backend's `ZOOM_RANGE`. */
export const ZOOM_LEVELS: readonly number[] = [80, 90, 100, 110, 125, 150].filter(
  (level) => level >= ZOOM_MIN && level <= ZOOM_MAX,
);
export const DEFAULT_ZOOM = 100;

/** The stored zoom (absent from preferences saved before it existed). */
export function currentZoom(): number {
  return currentPreferences().zoom ?? DEFAULT_ZOOM;
}

/**
 * The next level up (`1`) or down (`-1`) from `current`. A value between two levels (edited by
 * hand) goes to the nearest level in that direction; at either end it stays.
 */
export function stepZoom(current: number, direction: 1 | -1): number {
  const next =
    direction > 0
      ? ZOOM_LEVELS.find((level) => level > current)
      : ZOOM_LEVELS.findLast((level) => level < current);
  return next ?? current;
}

function setZoom(zoom: number): void {
  if (zoom !== currentZoom()) savePreferenceOrToast({ zoom });
}

export function zoomIn(): void {
  setZoom(stepZoom(currentZoom(), 1));
}

export function zoomOut(): void {
  setZoom(stepZoom(currentZoom(), -1));
}

export function resetZoom(): void {
  setZoom(DEFAULT_ZOOM);
}

let applied = DEFAULT_ZOOM;

function apply(zoom: number): void {
  if (zoom === applied) return;
  applied = zoom;
  nativeWindow.setZoom(zoom / 100).catch((error: unknown) => {
    console.warn('Could not set the zoom', error);
  });
}

/**
 * Applies the stored zoom now and after every change of the preference. The webview starts at
 * 100 %: nothing is sent until the preference says otherwise.
 */
export function watchZoom(): () => void {
  apply(currentZoom());
  return subscribePreferences(() => {
    apply(currentZoom());
  });
}

function canvasZoom(): number {
  return nativeWindow.zoomInPixelRatio ? 1 : currentZoom() / 100;
}

/**
 * What a canvas multiplies `devicePixelRatio` by to stay sharp: the zoom where the pixel ratio
 * does not include it (WebKit, the CSS zoom of the mock), else 1.
 */
export function useCanvasZoom(): number {
  return useSyncExternalStore(subscribePreferences, canvasZoom);
}
