import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import { useT } from '../../i18n/useT';
import { useTabsStore } from '../tabs/tabsStore';
import { clampPanelSize, PANEL_LIMITS, type PanelId, type PanelState } from './panels';
import styles from './PanelResizer.module.css';

const KEYBOARD_STEP = 16;

interface PanelResizerProps {
  tabId: string;
  panel: PanelId;
  state: PanelState;
  /** Side of the resizer the panel is on: dragging away from it grows the panel. */
  side: 'left' | 'right';
  /** Largest size that still leaves the center its minimum width. */
  maxSize: number;
}

/** Drag handle between two panels; arrows resize, Enter or double click collapses. */
export function PanelResizer({ tabId, panel, state, side, maxSize }: PanelResizerProps) {
  const t = useT();
  const setPanel = useTabsStore((store) => store.setPanel);
  const limits = PANEL_LIMITS[panel];
  const clamp = (size: number) =>
    Math.min(clampPanelSize(panel, size), Math.max(limits.min, maxSize));
  const label = t(panel === 'sidebar' ? 'layout.resizeSidebar' : 'layout.resizeDetails');

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startSize = state.collapsed ? 0 : state.size;
    const direction = side === 'left' ? 1 : -1;
    document.body.dataset.resizing = 'col';
    const onMove = (move: PointerEvent) => {
      const size = startSize + (move.clientX - startX) * direction;
      // Dragging well below the minimum collapses the panel, like most IDEs.
      if (size < limits.min / 2) setPanel(tabId, panel, { collapsed: true });
      else setPanel(tabId, panel, { collapsed: false, size: clamp(size) });
    };
    const onUp = () => {
      delete document.body.dataset.resizing;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (event.key === grow || event.key === shrink) {
      const delta = event.key === grow ? KEYBOARD_STEP : -KEYBOARD_STEP;
      setPanel(tabId, panel, { collapsed: false, size: clamp(state.size + delta) });
    } else if (event.key === 'Enter' || event.key === ' ') {
      setPanel(tabId, panel, { collapsed: !state.collapsed });
    } else {
      return;
    }
    event.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={limits.max}
      aria-valuenow={state.collapsed ? 0 : state.size}
      tabIndex={0}
      className={styles.resizer}
      data-side={side}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        setPanel(tabId, panel, { collapsed: !state.collapsed });
      }}
    />
  );
}
