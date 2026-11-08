import { useShellStore } from '../../app/shellStore';
import type { MessageKey } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { closeFirstRun } from './launchScreens';
import { ShortcutKeys } from './ShortcutKeys';
import styles from './FirstRunDialog.module.css';

/** A few shortcuts worth knowing on day one, as bound now (a rebinding shows). */
const ROWS: readonly { label: MessageKey; actions: readonly string[] }[] = [
  { label: 'firstRun.shortcut.palette', actions: ['app.palette'] },
  { label: 'firstRun.shortcut.commit', actions: ['git.commit'] },
  { label: 'firstRun.shortcut.sync', actions: ['git.fetch', 'git.pull', 'git.push'] },
  { label: 'firstRun.shortcut.branch', actions: ['git.branch.create'] },
];

export function FirstRunShortcuts() {
  const t = useT();
  return (
    <>
      <dl className={styles.shortcuts}>
        {ROWS.map((row) => (
          <div key={row.label} className={styles.shortcutRow}>
            <dt>{t(row.label)}</dt>
            <dd className={styles.keys}>
              {row.actions.map((id) => (
                <ShortcutKeys key={id} id={id} />
              ))}
            </dd>
          </div>
        ))}
      </dl>
      <div className={styles.actions}>
        <Button
          variant="ghost"
          onClick={() => {
            closeFirstRun();
            useShellStore.getState().setShortcutsOpen(true);
          }}
        >
          {t('firstRun.shortcuts.all')}
        </Button>
      </div>
    </>
  );
}
