import { useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { platform } from '../../ui/platform';
import { TextInput } from '../../ui/TextInput';
import { useKeybindings } from './keybindingsStore';
import { BINDING_GROUPS, listBindings, type BindingInfo } from './registry';
import { captureShortcut, effectiveShortcut, findConflicts, shortcutKey } from './resolve';
import styles from './KeybindingsTab.module.css';

/** What the row being edited is waiting for. */
type Editing =
  | { id: string; kind: 'capture' }
  | { id: string; kind: 'conflict'; shortcut: string; others: string[] }
  | { id: string; kind: 'invalid' };

interface KeybindingsTabProps {
  /** Filter to start with: the search of the Preferences dialog, when it names commands. */
  initialFilter?: string;
}

/** Shortcut editor (F-281): press the keys, conflicts are shown, defaults come back. */
export function KeybindingsTab({ initialFilter = '' }: KeybindingsTabProps) {
  const t = useT();
  const { overrides, path, problem } = useKeybindings();
  const [filter, setFilter] = useState(initialFilter);
  const [editing, setEditing] = useState<Editing | null>(null);

  // The file can be edited by hand: read it again each time the editor opens.
  useEffect(() => {
    void useKeybindings.getState().load();
  }, []);

  const rows = useMemo(
    () =>
      listBindings().map((binding) => ({
        binding,
        shortcut: effectiveShortcut(binding.id, binding.defaultShortcut, overrides),
        changed: binding.id in overrides,
      })),
    [overrides],
  );
  const byId = useMemo(() => new Map(rows.map((row) => [row.binding.id, row.binding])), [rows]);
  const conflicts = useMemo(() => {
    const shared = findConflicts(new Map(rows.map((r) => [r.binding.id, r.shortcut])));
    const perId = new Map<string, string[]>();
    for (const ids of shared.values()) {
      for (const id of ids)
        perId.set(
          id,
          ids.filter((other) => other !== id),
        );
    }
    return perId;
  }, [rows]);

  const label = (binding: BindingInfo) => t(binding.title, binding.titleParams);
  const query = filter.trim().toLowerCase();
  const visible = rows.filter(
    ({ binding, shortcut }) =>
      !query ||
      label(binding).toLowerCase().includes(query) ||
      binding.id.toLowerCase().includes(query) ||
      (shortcut?.toLowerCase().includes(query) ?? false),
  );
  const anyChange = Object.keys(overrides).length > 0;

  const nameOf = (ids: string[]) =>
    ids
      .map((id) => byId.get(id))
      .filter((b): b is BindingInfo => b !== undefined)
      .map(label)
      .join(', ');

  const onCapture = (id: string, event: React.KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const capture = captureShortcut(event.nativeEvent, platform);
    if (capture.kind === 'pending') return;
    if (capture.kind === 'cancel') {
      setEditing(null);
    } else if (capture.kind === 'invalid') {
      setEditing({ id, kind: 'invalid' });
    } else {
      const key = shortcutKey(capture.shortcut);
      const others = rows
        .filter(
          (r) => r.binding.id !== id && r.shortcut !== null && shortcutKey(r.shortcut) === key,
        )
        .map((r) => r.binding.id);
      if (others.length > 0) {
        setEditing({ id, kind: 'conflict', shortcut: capture.shortcut, others });
      } else {
        setEditing(null);
        void useKeybindings.getState().set(id, capture.shortcut);
      }
    }
  };

  return (
    <>
      <div className={styles.toolbar}>
        <TextInput
          className={styles.filter}
          value={filter}
          placeholder={t('keybindings.filter')}
          aria-label={t('keybindings.filter')}
          onChange={(event) => {
            setFilter(event.target.value);
          }}
        />
        <Button
          disabled={!anyChange}
          onClick={() => {
            setEditing(null);
            void useKeybindings.getState().resetAll();
          }}
        >
          {t('keybindings.resetAll')}
        </Button>
      </div>
      <p className={styles.file}>
        {t('keybindings.file')} <code>{path ?? 'keybindings.json'}</code>
      </p>
      {problem && (
        <p className={styles.problem} role="alert">
          <Icon name="warning" /> {t('keybindings.problem', { detail: problem })}
        </p>
      )}
      <div className={styles.list}>
        {BINDING_GROUPS.map((group) => {
          const items = visible.filter((row) => row.binding.group === group);
          if (items.length === 0) return null;
          return (
            <section key={group} aria-labelledby={`kb-${group}`}>
              <h3 id={`kb-${group}`} className={styles.heading}>
                {t(`keybindings.group.${group}`)}
              </h3>
              {items.map(({ binding, shortcut, changed }) => {
                const edit = editing?.id === binding.id ? editing : null;
                const clash = conflicts.get(binding.id);
                return (
                  <div key={binding.id} className={styles.row} data-binding-id={binding.id}>
                    <div className={styles.text}>
                      <span className={styles.title}>{label(binding)}</span>
                      {clash && !edit && (
                        <span className={styles.warning} role="status">
                          <Icon name="warning" />{' '}
                          {t('keybindings.conflict', { names: nameOf(clash) })}
                        </span>
                      )}
                      {edit?.kind === 'invalid' && (
                        <span className={styles.warning} role="status">
                          {t('keybindings.invalid')}
                        </span>
                      )}
                      {edit?.kind === 'conflict' && (
                        <span className={styles.warning} role="status">
                          <Icon name="warning" />{' '}
                          {t('keybindings.conflict.pick', { names: nameOf(edit.others) })}
                        </span>
                      )}
                    </div>
                    <div className={styles.controls}>
                      {edit?.kind === 'conflict' ? (
                        <>
                          <Kbd shortcut={edit.shortcut} />
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => {
                              const changes: Record<string, string | null> = {
                                [binding.id]: edit.shortcut,
                              };
                              for (const other of edit.others) changes[other] = null;
                              setEditing(null);
                              void useKeybindings.getState().setMany(changes);
                            }}
                          >
                            {t('keybindings.reassign')}
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => {
                              setEditing(null);
                            }}
                          >
                            {t('common.cancel')}
                          </Button>
                        </>
                      ) : edit ? (
                        <CaptureField
                          onKeyDown={(event) => {
                            onCapture(binding.id, event);
                          }}
                          onBlur={() => {
                            setEditing(null);
                          }}
                          label={t('keybindings.capture')}
                        />
                      ) : (
                        <>
                          <span className={styles.shortcut} data-changed={changed || undefined}>
                            {shortcut ? (
                              <Kbd shortcut={shortcut} />
                            ) : (
                              <span className={styles.unbound}>{t('keybindings.unbound')}</span>
                            )}
                          </span>
                          <Button
                            size="sm"
                            aria-label={t('keybindings.change', { name: label(binding) })}
                            onClick={() => {
                              setEditing({ id: binding.id, kind: 'capture' });
                            }}
                          >
                            {t('keybindings.edit')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={shortcut === null}
                            aria-label={t('keybindings.clear', { name: label(binding) })}
                            onClick={() => {
                              void useKeybindings.getState().set(binding.id, null);
                            }}
                          >
                            {t('keybindings.remove')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!changed}
                            aria-label={t('keybindings.reset', { name: label(binding) })}
                            onClick={() => {
                              void useKeybindings.getState().reset(binding.id);
                            }}
                          >
                            {t('keybindings.default')}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })}
        {visible.length === 0 && <p className={styles.empty}>{t('keybindings.empty')}</p>}
      </div>
    </>
  );
}

interface CaptureFieldProps {
  label: string;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onBlur: () => void;
}

/** A focused box that turns the next key press into a shortcut. */
function CaptureField({ label, onKeyDown, onBlur }: CaptureFieldProps) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <button
      ref={ref}
      type="button"
      className={styles.capture}
      data-capturing
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      {label}
    </button>
  );
}
