import { useId } from 'react';

import { usePreferences } from '../../app/usePreferences';
import { useT } from '../../i18n/useT';
import { AUTO_FETCH_MAX_MINUTES, AUTO_FETCH_MIN_MINUTES, type PullStrategy } from '../../ipc';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import { clampInt } from './prefsLogic';
import { Row } from './Row';
import { savePreferenceOrToast } from './savePreference';
import { Setting } from './Setting';
import { SettingDetails } from './SettingDetails';
import { useDraft } from './useDraft';
import styles from './SyncSection.module.css';

/** "No choice": a pull follows `pull.rebase` / `pull.ff` of the Git configuration. */
const GIT_CONFIG = 'gitConfig';

/** Automatic fetch, prune, tags on the remotes and the default pull strategy (F-324). */
export function SyncSection() {
  const t = useT();
  const prefs = usePreferences();
  const minutesId = useId();
  const [minutes, setMinutes] = useDraft(String(prefs.autoFetchMinutes));

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
      <Setting id="autoFetch">
        <Switch
          checked={prefs.autoFetch}
          label={t('prefs.autoFetch')}
          hint={t('prefs.autoFetch.hint')}
          onCheckedChange={(autoFetch) => {
            savePreferenceOrToast({ autoFetch });
          }}
        />
      </Setting>
      <Setting id="autoFetchMinutes">
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
      </Setting>
      <Setting id="prune">
        <Switch
          checked={prefs.prune}
          label={t('prefs.prune')}
          hint={t('prefs.prune.hint')}
          onCheckedChange={(prune) => {
            savePreferenceOrToast({ prune });
          }}
        />
      </Setting>
      <Setting id="remoteTags">
        <Switch
          checked={prefs.remoteTags === true}
          label={t('prefs.remoteTags')}
          hint={t('prefs.remoteTags.hint')}
          onCheckedChange={(remoteTags) => {
            savePreferenceOrToast({ remoteTags });
          }}
        />
        <SettingDetails
          summary={t('prefs.remoteTags.details')}
          sections={[
            {
              title: t('prefs.remoteTags.details.what.title'),
              body: t('prefs.remoteTags.details.what'),
            },
            {
              title: t('prefs.remoteTags.details.how.title'),
              body: t('prefs.remoteTags.details.how'),
            },
            {
              title: t('prefs.remoteTags.details.notes.title'),
              body: [
                t('prefs.remoteTags.details.notes.network'),
                t('prefs.remoteTags.details.notes.mismatch'),
                t('prefs.remoteTags.details.notes.offline'),
                t('prefs.remoteTags.details.notes.outside'),
              ],
            },
          ]}
        />
      </Setting>
      <Setting id="pullStrategy">
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
      </Setting>
    </>
  );
}
