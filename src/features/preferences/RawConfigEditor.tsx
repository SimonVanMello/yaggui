import { useVirtualizer } from '@tanstack/react-virtual';
import { useId, useRef, useState } from 'react';

import { useT } from '../../i18n/useT';
import type { ConfigEntry, ConfigScope } from '../../ipc';
import { Button } from '../../ui/Button';
import { TextInput } from '../../ui/TextInput';
import { filterEntries, normalizeConfigKey } from './gitConfigLogic';
import styles from './GitConfigTab.module.css';

interface RawConfigEditorProps {
  entries: readonly ConfigEntry[];
  /** Keys set several times: listed, not editable in place. */
  multiple: ReadonlySet<string>;
  scope: ConfigScope;
  onWrite: (key: string, value: string | null) => Promise<boolean>;
}

const ROW_HEIGHT_REM = 2.25;

/** `key#n`: the n-th entry of that key (a multi-valued key is listed once per value). */
function rowId(entries: readonly ConfigEntry[], entry: ConfigEntry): string {
  const key = normalizeConfigKey(entry.key);
  let occurrence = 0;
  for (const other of entries) {
    if (other === entry) break;
    if (normalizeConfigKey(other.key) === key) occurrence++;
  }
  return `${key}#${String(occurrence)}`;
}

/** Raw editor (F-325): every entry of the file, with add, edit and remove. */
export function RawConfigEditor({ entries, multiple, scope, onWrite }: RawConfigEditorProps) {
  const t = useT();
  const headingId = useId();
  const [filter, setFilter] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  // Rows are identified by key (and occurrence, for a key set several times), never by index:
  // after a removal the indexes shift, and a draft would be written under another key.
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // Any refetch (a write here or in the common fields) drops the pending edit and removal.
  const [seen, setSeen] = useState(entries);
  if (seen !== entries) {
    setSeen(entries);
    setEditing(null);
    setConfirming(null);
  }
  const scroller = useRef<HTMLDivElement>(null);

  const visible = filterEntries(entries, filter);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT_REM * rem,
    overscan: 8,
  });

  const add = async () => {
    const key = newKey.trim();
    if (!key) return;
    if (await onWrite(key, newValue)) {
      setNewKey('');
      setNewValue('');
    }
  };

  return (
    <section aria-labelledby={headingId} className={styles.raw} data-scope={scope}>
      <h3 id={headingId} className={styles.heading}>
        {t('gitconfig.raw')}
      </h3>
      <form
        className={styles.add}
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <TextInput
          mono
          value={newKey}
          placeholder={t('gitconfig.raw.key')}
          aria-label={t('gitconfig.raw.key')}
          onChange={(event) => {
            setNewKey(event.target.value);
          }}
        />
        <TextInput
          mono
          value={newValue}
          placeholder={t('gitconfig.raw.value')}
          aria-label={t('gitconfig.raw.value')}
          onChange={(event) => {
            setNewValue(event.target.value);
          }}
        />
        <Button type="submit" variant="primary" disabled={!newKey.trim()}>
          {t('gitconfig.raw.add')}
        </Button>
      </form>
      <TextInput
        value={filter}
        placeholder={t('gitconfig.raw.filter')}
        aria-label={t('gitconfig.raw.filter')}
        onChange={(event) => {
          setFilter(event.target.value);
        }}
      />
      <div ref={scroller} className={styles.scroller} role="table" aria-label={t('gitconfig.raw')}>
        <div className={styles.rows} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const entry = visible[item.index];
            if (!entry) return null;
            const key = normalizeConfigKey(entry.key);
            const locked = multiple.has(key);
            const id = rowId(entries, entry);
            const isEditing = editing?.id === id;
            return (
              <div
                key={id}
                role="row"
                className={styles.entry}
                style={{ height: item.size, transform: `translateY(${String(item.start)}px)` }}
              >
                <code className={styles.entryKey} role="cell" title={entry.key}>
                  {entry.key}
                </code>
                {isEditing ? (
                  <TextInput
                    mono
                    autoFocus
                    className={styles.entryValue}
                    value={editing.draft}
                    aria-label={t('gitconfig.raw.edit', { key: entry.key })}
                    onChange={(event) => {
                      setEditing({ id, draft: event.target.value });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.stopPropagation();
                        setEditing(null);
                      } else if (event.key === 'Enter') {
                        event.preventDefault();
                        void onWrite(entry.key, editing.draft).then((saved) => {
                          if (saved) setEditing(null);
                        });
                      }
                    }}
                  />
                ) : (
                  <code className={styles.entryValue} role="cell" title={entry.value ?? ''}>
                    {entry.value ?? <em>{t('gitconfig.raw.bare')}</em>}
                  </code>
                )}
                <span className={styles.entryActions} role="cell">
                  {confirming === id ? (
                    <>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          setConfirming(null);
                          void onWrite(entry.key, null);
                        }}
                      >
                        {locked ? t('gitconfig.raw.removeAll') : t('gitconfig.raw.confirm')}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          setConfirming(null);
                        }}
                      >
                        {t('common.cancel')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={locked || isEditing}
                        title={locked ? t('gitconfig.raw.multiple') : undefined}
                        aria-label={t('gitconfig.raw.edit', { key: entry.key })}
                        onClick={() => {
                          setEditing({ id, draft: entry.value ?? '' });
                        }}
                      >
                        {t('keybindings.edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('gitconfig.raw.remove', { key: entry.key })}
                        onClick={() => {
                          setConfirming(id);
                        }}
                      >
                        {t('keybindings.remove')}
                      </Button>
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        {visible.length === 0 && <p className={styles.empty}>{t('gitconfig.raw.empty')}</p>}
      </div>
    </section>
  );
}
