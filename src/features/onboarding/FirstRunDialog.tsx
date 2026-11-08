import { useShellStore } from '../../app/shellStore';
import { usePreferences } from '../../app/usePreferences';
import { useI18nStore, type Locale } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { themeForMode } from '../../theme/catalog';
import { useThemeStore, type ThemePreference } from '../../theme/themeStore';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Switch } from '../../ui/Switch';
import { savePreferenceOrToast } from '../preferences/savePreference';
import { FirstRunGit } from './FirstRunGit';
import { FirstRunSection } from './FirstRunSection';
import { FirstRunShortcuts } from './FirstRunShortcuts';
import { closeFirstRun } from './launchScreens';
import { DOCS_PAGES, openDocs } from './openDocs';
import styles from './FirstRunDialog.module.css';

const SYSTEM = 'system';

/**
 * The first-launch screen: the few choices worth making before the first repository. Every
 * choice applies and saves at once; closing it, by any means, marks it as seen.
 */
export function FirstRunDialog() {
  const open = useShellStore((state) => state.firstRunOpen);
  const t = useT();
  const prefs = usePreferences();
  const locale = useI18nStore((state) => state.preference);
  const theme = useThemeStore((state) => state.preference);
  const lightName = themeForMode(prefs.lightTheme, false).name;
  const darkName = themeForMode(prefs.darkTheme, true).name;

  return (
    <Dialog
      open={open}
      wide
      onOpenChange={(next) => {
        if (!next) closeFirstRun();
      }}
      title={t('firstRun.title')}
      description={t('firstRun.local')}
      footer={
        <>
          <Button onClick={() => void openDocs(DOCS_PAGES.home)}>
            <Icon name="external" />
            {t('firstRun.docs')}
          </Button>
          <Button variant="primary" onClick={closeFirstRun}>
            {t('firstRun.start')}
          </Button>
        </>
      }
    >
      <div className={styles.sections}>
        <FirstRunSection title={t('settings.language')}>
          <SegmentedControl<Locale | typeof SYSTEM>
            label={t('settings.language')}
            value={locale ?? SYSTEM}
            options={[
              { value: 'fr', label: 'Français' },
              { value: 'en', label: 'English' },
              { value: SYSTEM, label: t('settings.language.system') },
            ]}
            onChange={(value) => {
              useI18nStore.getState().setPreference(value === SYSTEM ? null : value);
            }}
          />
        </FirstRunSection>
        <FirstRunSection title={t('firstRun.appearance')}>
          <SegmentedControl<ThemePreference>
            label={t('firstRun.appearance')}
            value={theme}
            options={[
              { value: 'light', label: t('settings.theme.light') },
              { value: 'dark', label: t('settings.theme.dark') },
              { value: 'system', label: t('settings.theme.system') },
            ]}
            onChange={(value) => {
              useThemeStore.getState().setPreference(value);
            }}
          />
          <p className={styles.hint}>
            {t('firstRun.appearance.hint', { light: lightName, dark: darkName })}
          </p>
        </FirstRunSection>
        <FirstRunSection title={t('firstRun.git')}>
          <FirstRunGit />
        </FirstRunSection>
        <FirstRunSection title={t('prefs.subsection.updates')}>
          <div className={styles.full}>
            <Switch
              checked={prefs.checkUpdates === true}
              label={t('prefs.checkUpdates')}
              hint={t('prefs.checkUpdates.hint')}
              onCheckedChange={(checkUpdates) => {
                savePreferenceOrToast({ checkUpdates });
              }}
            />
          </div>
        </FirstRunSection>
        <FirstRunSection title={t('firstRun.shortcuts')}>
          <FirstRunShortcuts />
        </FirstRunSection>
      </div>
    </Dialog>
  );
}
