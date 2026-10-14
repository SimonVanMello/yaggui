import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { useShortcut } from '../keybindings/registry';
import {
  attachTerminal,
  closeTerminal,
  detachTerminal,
  fitTerminal,
  newTerminal,
} from './terminalSessions';
import {
  hideTerminalPanel,
  TERMINAL_HEIGHT,
  useRepoTerminals,
  useTerminalStore,
} from './terminalStore';
import styles from './TerminalPanel.module.css';

const KEYBOARD_STEP = 16;

/** Integrated terminals of a repository (F-267), at the bottom of its view. Loaded lazily. */
export default function TerminalPanel({ repoId }: { repoId: number }) {
  const t = useT();
  const { open, tabs, activeId } = useRepoTerminals(repoId);
  const height = useTerminalStore((state) => state.height);
  const toggleShortcut = useShortcut('terminal.toggle');
  const newShortcut = useShortcut('terminal.new');
  const bodyRef = useRef<HTMLDivElement>(null);
  const active = tabs.find((tab) => tab.id === activeId) ?? null;

  // The emulator element moves in while shown and back to the parking element after: the
  // terminal keeps running (and its scrollback) when the panel or the repository is hidden.
  useEffect(() => {
    const body = bodyRef.current;
    if (!open || !activeId || !body) return;
    attachTerminal(activeId, body);
    return () => {
      detachTerminal(activeId);
    };
  }, [open, activeId]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!open || !activeId || !body) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        fitTerminal(activeId);
      });
    });
    observer.observe(body);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [open, activeId]);

  if (!open) return null;

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    document.body.dataset.resizing = 'row';
    const onMove = (move: PointerEvent) => {
      useTerminalStore.getState().setHeight(startHeight + startY - move.clientY);
    };
    const onUp = () => {
      delete document.body.dataset.resizing;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onResizeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? KEYBOARD_STEP : -KEYBOARD_STEP;
    useTerminalStore.getState().setHeight(height + delta);
  };

  return (
    <section className={styles.panel} style={{ height }} aria-label={t('terminal.panel')}>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('terminal.resize')}
        aria-valuemin={TERMINAL_HEIGHT.min}
        aria-valuenow={height}
        tabIndex={0}
        className={styles.resizer}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKey}
      />
      <header className={styles.header}>
        <div role="tablist" aria-label={t('terminal.tabs')} className={styles.tabs}>
          {tabs.map((tab) => {
            const selected = tab.id === activeId;
            return (
              <div
                key={tab.id}
                className={styles.tab}
                data-selected={selected || undefined}
                data-status={tab.status}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={styles.tabButton}
                  onClick={() => {
                    useTerminalStore.getState().activate(repoId, tab.id);
                  }}
                >
                  <Icon name="terminal" size="sm" />
                  <span className={styles.tabTitle}>{tab.title}</span>
                </button>
                <button
                  type="button"
                  className={styles.tabClose}
                  aria-label={t('terminal.close', { name: tab.title })}
                  onClick={() => {
                    closeTerminal(repoId, tab.id);
                  }}
                >
                  <Icon name="close" size="sm" />
                </button>
              </div>
            );
          })}
        </div>
        <IconButton
          icon="plus"
          size="sm"
          label={t('terminal.new')}
          shortcut={newShortcut}
          onClick={() => {
            newTerminal(repoId);
          }}
        />
        <span className={styles.headerActions}>
          <IconButton
            icon="close"
            size="sm"
            label={t('terminal.hide')}
            shortcut={toggleShortcut}
            onClick={() => {
              hideTerminalPanel(repoId);
            }}
          />
        </span>
      </header>
      <div className={styles.body} data-status={active?.status}>
        <div ref={bodyRef} className={styles.screen} />
        {active?.status === 'failed' && active.error && (
          <div className={styles.overlay}>
            <ErrorPanel compact title={t('terminal.failed')} error={active.error} />
          </div>
        )}
      </div>
    </section>
  );
}
