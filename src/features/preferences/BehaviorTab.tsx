import { useId, useState } from 'react';

import { usePreferences } from '../../app/usePreferences';
import { useT } from '../../i18n/useT';
import type { MessageKey } from '../../i18n/i18n';
import {
  AUTO_FETCH_MAX_MINUTES,
  AUTO_FETCH_MIN_MINUTES,
  type ConfirmationKind,
  type PullStrategy,
} from '../../ipc';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import { clampInt, setConfirmation } from './prefsLogic';
import { ProtectedBranchesField } from './ProtectedBranchesField';
import { Row } from './Row';
import { savePreferenceOrToast } from './savePreference';
import styles from './BehaviorTab.module.css';

/** "No choice": a pull follows `pull.rebase` / `pull.ff` of the Git configuration. */
const GIT_CONFIG = 'gitConfig';

const CONFIRMATIONS: readonly ConfirmationKind[] = [
  'discardChanges',
  'deleteTag',
  'dropStash',
  'forcePush',
];

export function BehaviorTab() {
  const t = useT();
  const prefs = usePreferences();
  const minutesId = useId();
  const [minutes, setMinutes] = useState(String(prefs.autoFetchMinutes));

  const commitMinutes = () => {
    const value = clampInt(
      minutes,
      AUTO_FETCH_MIN_MINUTES,
      AUTO_FETCH_MAX_MINUTES,
      prefs.autoFetchMinutes,
    );
    setMinutes(String(value));
    if (value !== prefs.autoFetchMinutes) savePreferenceOrToast({ autoFetchMinutes: value });
  };

  return (
    <>
      <Switch
        checked={prefs.autoFetch}
        label={t('prefs.autoFetch')}
        hint={t('prefs.autoFetch.hint')}
        onCheckedChange={(autoFetch) => {
          savePreferenceOrToast({ autoFetch });
        }}
      />
      <Row label={t('prefs.autoFetchMinutes')} htmlFor={minutesId}>
        <TextInput
          id={minutesId}
          className={styles.minutes}
          inputMode="numeric"
          disabled={!prefs.autoFetch}
          value={minutes}
          onChange={(event) => {
            setMinutes(event.target.value);
          }}
          onBlur={commitMinutes}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitMinutes();
            }
          }}
        />
      </Row>
      <Switch
        checked={prefs.prune}
        label={t('prefs.prune')}
        hint={t('prefs.prune.hint')}
        onCheckedChange={(prune) => {
          savePreferenceOrToast({ prune });
        }}
      />
      <Row label={t('prefs.pull')} hint={t('prefs.pull.hint')}>
        <SegmentedControl<PullStrategy | typeof GIT_CONFIG>
          label={t('prefs.pull')}
          value={prefs.pullStrategy ?? GIT_CONFIG}
          options={[
            { value: GIT_CONFIG, label: t('prefs.pull.auto') },
            { value: 'ffOnly', label: t('prefs.pull.ffOnly') },
            { value: 'merge', label: t('prefs.pull.merge') },
            { value: 'rebase', label: t('prefs.pull.rebase') },
          ]}
          onChange={(value) => {
            savePreferenceOrToast({ pullStrategy: value === GIT_CONFIG ? null : value });
          }}
        />
      </Row>
      <ProtectedBranchesField />
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
    </>
  );
}
