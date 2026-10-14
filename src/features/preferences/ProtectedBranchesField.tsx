import { useId, useState } from 'react';

import { usePreferences } from '../../app/usePreferences';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { TextInput } from '../../ui/TextInput';
import { addProtectedBranch, canAddProtectedBranch, removeProtectedBranch } from './prefsLogic';
import { savePreferenceOrToast } from './savePreference';
import styles from './ProtectedBranchesField.module.css';

/** The default list, restored by "Restore defaults" (same as the backend's). */
const DEFAULT_PROTECTED = ['main', 'master', 'develop', 'release/*'];

/** Editable list of protected branch names and patterns (F-324). */
export function ProtectedBranchesField() {
  const t = useT();
  const inputId = useId();
  const { protectedBranches } = usePreferences();
  const [draft, setDraft] = useState('');
  const canAdd = canAddProtectedBranch(protectedBranches, draft);

  const add = () => {
    if (!canAdd) return;
    savePreferenceOrToast({ protectedBranches: addProtectedBranch(protectedBranches, draft) });
    setDraft('');
  };

  return (
    <div className={styles.field}>
      <div className={styles.header}>
        <label className={styles.label} htmlFor={inputId}>
          {t('prefs.protected')}
        </label>
        <button
          type="button"
          className={styles.reset}
          onClick={() => {
            savePreferenceOrToast({ protectedBranches: DEFAULT_PROTECTED });
          }}
        >
          {t('prefs.protected.reset')}
        </button>
      </div>
      <p className={styles.hint}>{t('prefs.protected.hint')}</p>
      {protectedBranches.length === 0 ? (
        <p className={styles.empty}>{t('prefs.protected.empty')}</p>
      ) : (
        <ul className={styles.list}>
          {protectedBranches.map((pattern) => (
            <li key={pattern} className={styles.chip}>
              <span className={styles.name}>{pattern}</span>
              <button
                type="button"
                className={styles.remove}
                aria-label={t('prefs.protected.remove', { name: pattern })}
                onClick={() => {
                  savePreferenceOrToast({
                    protectedBranches: removeProtectedBranch(protectedBranches, pattern),
                  });
                }}
              >
                <Icon name="close" size="sm" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.add}>
        <TextInput
          id={inputId}
          mono
          value={draft}
          placeholder={t('prefs.protected.add')}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button disabled={!canAdd} onClick={add}>
          {t('prefs.protected.addAction')}
        </Button>
      </div>
    </div>
  );
}
