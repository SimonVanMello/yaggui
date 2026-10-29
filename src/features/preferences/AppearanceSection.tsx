import { usePreferences } from '../../app/usePreferences';
import { useT } from '../../i18n/useT';
import type { ThemeStyle } from '../../ipc';
import { useThemeStore } from '../../theme/themeStore';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Switch } from '../../ui/Switch';
import { Row } from './Row';
import { savePreferenceOrToast } from './savePreference';
import { Setting } from './Setting';
import { ThemeGallery } from './theme/ThemeGallery';
import styles from './AppearanceSection.module.css';

/** Color theme, light / dark mode, interface style and contrast (F-320). */
export function AppearanceSection() {
  const t = useT();
  const prefs = usePreferences();
  const preference = useThemeStore((state) => state.preference);
  const style = useThemeStore((state) => state.style);
  const setStyle = useThemeStore((state) => state.setStyle);
  return (
    <>
      <Setting id="followSystem">
        <Switch
          checked={preference === 'system'}
          label={t('prefs.followSystem')}
          hint={t('prefs.followSystem.hint')}
          onCheckedChange={(follow) => {
            const store = useThemeStore.getState();
            // Turning it off keeps the theme on screen: the mode the OS is in right now.
            const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            store.setPreference(follow ? 'system' : dark ? 'dark' : 'light');
          }}
        />
      </Setting>
      <Setting id="theme">
        <div className={styles.theme}>
          <span className={styles.label}>{t('settings.theme')}</span>
          <ThemeGallery />
        </div>
      </Setting>
      <Setting id="style">
        <Row label={t('prefs.style')} hint={t('prefs.style.hint')}>
          <SegmentedControl<ThemeStyle>
            label={t('prefs.style')}
            value={style}
            options={[
              { value: 'standard', label: t('prefs.style.standard') },
              { value: 'terminal', label: t('prefs.style.terminal') },
            ]}
            onChange={setStyle}
          />
        </Row>
      </Setting>
      <Setting id="contrast">
        <Switch
          checked={prefs.highContrast}
          label={t('prefs.contrast')}
          hint={t('prefs.contrast.hint')}
          onCheckedChange={(highContrast) => {
            savePreferenceOrToast({ highContrast });
          }}
        />
      </Setting>
    </>
  );
}
