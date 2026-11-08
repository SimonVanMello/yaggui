import { useT } from '../../i18n/useT';
import { Kbd } from '../../ui/Kbd';
import { useShortcut } from '../keybindings/registry';
import styles from './FirstRunDialog.module.css';

/** The current shortcut of a command, or "No shortcut". */
export function ShortcutKeys({ id }: { id: string }) {
  const t = useT();
  const shortcut = useShortcut(id);
  return shortcut ? (
    <Kbd shortcut={shortcut} />
  ) : (
    <span className={styles.unbound}>{t('keybindings.unbound')}</span>
  );
}
