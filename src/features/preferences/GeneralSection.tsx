import { useShellStore } from '../../app/shellStore';
import { useAppInfo } from '../../app/useAppInfo';
import { usePreferences } from '../../app/usePreferences';
import { useI18nStore, type Locale } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Switch } from '../../ui/Switch';
import { checkForUpdatesNow } from '../updates/updates';
import { exportPreferencesFile, startPreferencesImport } from './prefsSync';
import { Row } from './Row';
import { savePreferenceOrToast } from './savePreference';
import { Setting } from './Setting';
import { SettingGroup } from './SettingGroup';

const SYSTEM = 'system';

/** Language (F-321), update check and version, import / export of the preferences (F-326). */
export function GeneralSection() {
  const t = useT();
  const prefs = usePreferences();
  const appVersion = useAppInfo().data?.appVersion;
  const locale = useI18nStore((state) => state.preference);
  const setLocale = useI18nStore((state) => state.setPreference);
  return (
    <>
      <Setting id="language">
        <Row label={t('settings.language')}>
          <SegmentedControl<Locale | typeof SYSTEM>
            label={t('settings.language')}
            value={locale ?? SYSTEM}
            options={[
              { value: SYSTEM, label: t('settings.language.system') },
              { value: 'en', label: 'English' },
              { value: 'fr', label: 'Français' },
            ]}
            onChange={(value) => {
              setLocale(value === SYSTEM ? null : value);
            }}
          />
        </Row>
      </Setting>
      <SettingGroup
        title={t('prefs.subsection.updates')}
        ids={['checkUpdates', 'checkUpdatesNow', 'version']}
      >
        <Setting id="checkUpdates">
          <Switch
            checked={prefs.checkUpdates === true}
            label={t('prefs.checkUpdates')}
            hint={t('prefs.checkUpdates.hint')}
            onCheckedChange={(checkUpdates) => {
              savePreferenceOrToast({ checkUpdates });
            }}
          />
        </Setting>
        <Setting id="checkUpdatesNow">
          <Row label={t('prefs.checkUpdates.now')}>
            <Button onClick={() => void checkForUpdatesNow()}>{t('prefs.checkUpdates.now')}</Button>
          </Row>
        </Setting>
        <Setting id="version">
          <Row
            label={t('prefs.version')}
            hint={appVersion ? t('prefs.version.hint', { version: appVersion }) : undefined}
          >
            <Button
              onClick={() => {
                const shell = useShellStore.getState();
                shell.setPreferencesOpen(false);
                shell.setChangelogOpen(true);
              }}
            >
              {t('changelog.open')}
            </Button>
          </Row>
        </Setting>
      </SettingGroup>
      <SettingGroup title={t('prefs.subsection.backup')} ids={['backup']}>
        <Setting id="backup">
          <Row label={t('prefs.backup')} hint={t('prefs.backup.hint')}>
            <Button
              onClick={() => {
                void startPreferencesImport();
              }}
            >
              {t('prefs.sync.import')}
            </Button>
            <Button
              onClick={() => {
                void exportPreferencesFile();
              }}
            >
              {t('prefs.sync.export')}
            </Button>
          </Row>
        </Setting>
      </SettingGroup>
    </>
  );
}
