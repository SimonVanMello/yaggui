import { useT } from '../../i18n/useT';
import type { MessageKey } from '../../i18n/i18n';
import type { ShortcutState } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Kbd } from '../../ui/Kbd';
import { defaultShortcutOf, listBindings } from '../keybindings/registry';
import { applyPreferencesImport, closePreferencesImport, usePrefsSync } from './prefsSync';
import { formatPrefValue, hasChanges, ignoredKeys, preferenceLabel } from './syncLogic';
import styles from './PreferencesImportDialog.module.css';

/** What importing a preferences file would change, shown before anything is applied (F-326). */
export function PreferencesImportDialog() {
  const t = useT();
  const preview = usePrefsSync((state) => state.preview);
  const applying = usePrefsSync((state) => state.applying);

  const words = {
    none: t('prefs.sync.value.none'),
    yes: t('prefs.sync.value.yes'),
    no: t('prefs.sync.value.no'),
    empty: t('prefs.sync.value.empty'),
  };

  const shortcutOf = (action: string, state: ShortcutState) => {
    if (state.custom) {
      return state.shortcut ? <Kbd shortcut={state.shortcut} /> : t('prefs.sync.noShortcut');
    }
    const fallback = defaultShortcutOf(action);
    return fallback ? <Kbd shortcut={fallback} /> : t('prefs.sync.noShortcut');
  };

  const titles = new Map<string, MessageKey>(
    listBindings().map((binding) => [binding.id, binding.title]),
  );

  const machine = preview ? ignoredKeys(preview, 'machineSpecific') : [];
  const unknown = preview ? ignoredKeys(preview, 'unknown') : [];
  const changed = preview ? hasChanges(preview) : false;

  return (
    <Dialog
      open={preview !== null}
      wide
      onOpenChange={(open) => {
        if (!open) closePreferencesImport();
      }}
      title={t('prefs.sync.importTitle')}
      description={preview?.path}
      footer={
        <>
          <Button variant="ghost" disabled={applying} onClick={closePreferencesImport}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!changed || applying}
            onClick={() => {
              void applyPreferencesImport();
            }}
          >
            {t('prefs.sync.apply')}
          </Button>
        </>
      }
    >
      {preview && (
        <div className={styles.body}>
          {!changed && <p className={styles.note}>{t('prefs.sync.nothing')}</p>}
          {preview.changes.length > 0 && (
            <section aria-label={t('prefs.sync.section.preferences')}>
              <h3 className={styles.heading}>{t('prefs.sync.section.preferences')}</h3>
              <ul className={styles.list}>
                {preview.changes.map((change) => {
                  const label = preferenceLabel(change.key);
                  return (
                    <li key={change.key} className={styles.item}>
                      <span className={styles.name}>{label ? t(label) : change.key}</span>
                      <span className={styles.before}>{formatPrefValue(change.before, words)}</span>
                      <span className={styles.arrow} aria-hidden>
                        →
                      </span>
                      <span className={styles.after}>{formatPrefValue(change.after, words)}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {preview.keybindingChanges.length > 0 && (
            <section aria-label={t('prefs.sync.section.shortcuts')}>
              <h3 className={styles.heading}>{t('prefs.sync.section.shortcuts')}</h3>
              <ul className={styles.list}>
                {preview.keybindingChanges.map((change) => {
                  const title = titles.get(change.action);
                  return (
                    <li key={change.action} className={styles.item}>
                      <span className={styles.name}>{title ? t(title) : change.action}</span>
                      <span className={styles.before}>
                        {shortcutOf(change.action, change.before)}
                      </span>
                      <span className={styles.arrow} aria-hidden>
                        →
                      </span>
                      <span className={styles.after}>
                        {shortcutOf(change.action, change.after)}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className={styles.note}>{t('prefs.sync.shortcutsReplace')}</p>
            </section>
          )}
          {(machine.length > 0 || unknown.length > 0) && (
            <section aria-label={t('prefs.sync.section.ignored')}>
              <h3 className={styles.heading}>{t('prefs.sync.section.ignored')}</h3>
              {machine.length > 0 && (
                <p className={styles.note}>
                  {t('prefs.sync.ignored.machine')} <code>{machine.join(', ')}</code>
                </p>
              )}
              {unknown.length > 0 && (
                <p className={styles.note}>
                  {t('prefs.sync.ignored.unknown')} <code>{unknown.join(', ')}</code>
                </p>
              )}
            </section>
          )}
        </div>
      )}
    </Dialog>
  );
}
