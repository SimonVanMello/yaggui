import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useRefDialogs, type RefDialog } from './refDialogsStore';
import styles from './RefDialogs.module.css';

type Props = Extract<RefDialog, { kind: 'stashConflict' }>;

/** A stash apply / pop conflicted: the stash is kept, the files hold the conflict markers. */
export function StashConflictDialog({ paths, checkedOut }: Props) {
  const t = useT();
  const close = useRefDialogs((state) => state.close);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('refs.conflict.title')}
      description={t(checkedOut ? 'refs.conflict.checkedOut' : 'refs.conflict.description')}
      footer={
        <Button variant="primary" onClick={close}>
          {t('refs.conflict.ok')}
        </Button>
      }
    >
      <div className={styles.form}>
        <ul className={styles.files} aria-label={t('refs.conflict.files')}>
          {paths.map((path) => (
            <li key={path} title={path}>
              {path}
            </li>
          ))}
        </ul>
        <b>{t('refs.conflict.todo')}</b>
        <ol className={styles.steps}>
          <li>{t('refs.conflict.step1')}</li>
          <li>{t('refs.conflict.step2')}</li>
          <li>{t('refs.conflict.step3')}</li>
        </ol>
      </div>
    </Dialog>
  );
}
