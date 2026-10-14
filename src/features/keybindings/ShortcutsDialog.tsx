import { useMemo } from 'react';

import { useShellStore } from '../../app/shellStore';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Kbd } from '../../ui/Kbd';
import { useKeybindings } from './keybindingsStore';
import { BINDING_GROUPS, listBindings } from './registry';
import { effectiveShortcut } from './resolve';
import styles from './ShortcutsDialog.module.css';

/** Keyboard shortcut sheet (F-283), generated from the registry: it shows the user's bindings. */
export function ShortcutsDialog() {
  const open = useShellStore((state) => state.shortcutsOpen);
  const t = useT();
  const overrides = useKeybindings((state) => state.overrides);

  const groups = useMemo(() => {
    if (!open) return [];
    const bindings = listBindings().map((binding) => ({
      binding,
      shortcut: effectiveShortcut(binding.id, binding.defaultShortcut, overrides),
    }));
    return BINDING_GROUPS.map((group) => ({
      group,
      items: bindings.filter((b) => b.binding.group === group && b.shortcut !== null),
    })).filter((g) => g.items.length > 0);
  }, [open, overrides]);

  return (
    <Dialog
      open={open}
      wide
      onOpenChange={(next) => {
        useShellStore.getState().setShortcutsOpen(next);
      }}
      title={t('shortcuts.title')}
      description={t('shortcuts.description')}
      footer={
        <>
          <Button
            onClick={() => {
              const shell = useShellStore.getState();
              shell.setShortcutsOpen(false);
              shell.setPreferencesOpen(true, 'keybindings');
            }}
          >
            {t('shortcuts.edit')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              useShellStore.getState().setShortcutsOpen(false);
            }}
          >
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className={styles.columns}>
        {groups.map(({ group, items }) => (
          <section key={group} className={styles.group} aria-labelledby={`shortcuts-${group}`}>
            <h3 id={`shortcuts-${group}`} className={styles.heading}>
              {t(`keybindings.group.${group}`)}
            </h3>
            <ul className={styles.list}>
              {items.map(({ binding, shortcut }) => (
                <li key={binding.id} className={styles.item}>
                  <span className={styles.title}>{t(binding.title, binding.titleParams)}</span>
                  {shortcut && <Kbd shortcut={shortcut} />}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
