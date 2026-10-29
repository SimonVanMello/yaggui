import type { MessageKey } from '../../i18n/i18n';
import { usePreferences } from '../../app/usePreferences';
import { useT } from '../../i18n/useT';
import type { ConfirmationKind } from '../../ipc';
import { Switch } from '../../ui/Switch';
import { setConfirmation } from './prefsLogic';
import { ProtectedBranchesField } from './ProtectedBranchesField';
import { savePreferenceOrToast } from './savePreference';
import { Setting } from './Setting';
import styles from './SafetySection.module.css';

const CONFIRMATIONS: readonly ConfirmationKind[] = [
  'discardChanges',
  'deleteTag',
  'dropStash',
  'forcePush',
];

/** Protected branches and the confirmations that can be turned off (F-324). */
export function SafetySection() {
  const t = useT();
  const prefs = usePreferences();
  return (
    <>
      <Setting id="protectedBranches">
        <ProtectedBranchesField />
      </Setting>
      <Setting id="confirmations">
        <fieldset className={styles.confirmations}>
          <legend className={styles.legend}>{t('prefs.confirmations')}</legend>
          <p className={styles.hint}>{t('prefs.confirmations.hint')}</p>
          {CONFIRMATIONS.map((kind) => {
            const locked = kind === 'forcePush';
            return (
              <Switch
                key={kind}
                checked={locked || !prefs.disabledConfirmations.includes(kind)}
                disabled={locked}
                label={t(`prefs.confirm.${kind}` as MessageKey)}
                hint={locked ? t('prefs.confirm.forcePush.hint') : undefined}
                onCheckedChange={(enabled) => {
                  savePreferenceOrToast({
                    disabledConfirmations: setConfirmation(
                      prefs.disabledConfirmations,
                      kind,
                      enabled,
                    ),
                  });
                }}
              />
            );
          })}
        </fieldset>
      </Setting>
    </>
  );
}
