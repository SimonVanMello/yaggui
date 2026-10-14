import { useId, useState } from 'react';

import { usePreferences } from '../../app/usePreferences';
import { useI18nStore, type Locale } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  YagguiIpcError,
  type Density,
  type ThemeStyle,
} from '../../ipc';
import { useThemeStore, type ThemePreference } from '../../theme/themeStore';
import { Button } from '../../ui/Button';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import { toast } from '../../ui/toastStore';
import { clearGravatarCache } from '../graph/gravatar';
import { savePreferenceOrToast } from './savePreference';
import { Row } from './Row';
import styles from './AppearanceTab.module.css';

const SYSTEM = 'system';

export function AppearanceTab() {
  const t = useT();
  const prefs = usePreferences();
  const theme = useThemeStore((state) => state.preference);
  const setTheme = useThemeStore((state) => state.setPreference);
  const style = useThemeStore((state) => state.style);
  const setStyle = useThemeStore((state) => state.setStyle);
  const locale = useI18nStore((state) => state.preference);
  const setLocale = useI18nStore((state) => state.setPreference);
  const clearAvatars = () => {
    clearGravatarCache().then(
      () => {
        toast({ variant: 'success', title: t('prefs.gravatar.cleared') });
      },
      (failure: unknown) => {
        toast({
          variant: 'error',
          title: t('prefs.saveFailed'),
          description:
            failure instanceof YagguiIpcError
              ? failure.error.message[useI18nStore.getState().locale]
              : undefined,
        });
      },
    );
  };
  const ids = { ui: useId(), code: useId(), size: useId() };

  return (
    <>
      <Row label={t('settings.theme')}>
        <SegmentedControl<ThemePreference>
          label={t('settings.theme')}
          value={theme}
          options={[
            { value: 'system', label: t('settings.theme.system') },
            { value: 'light', label: t('settings.theme.light') },
            { value: 'dark', label: t('settings.theme.dark') },
          ]}
          onChange={setTheme}
        />
      </Row>
      <Row
        label={t('prefs.style')}
        hint={style === 'terminal' ? t('prefs.style.terminalHint') : undefined}
      >
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
      <Switch
        checked={prefs.highContrast}
        label={t('prefs.contrast')}
        hint={t('prefs.contrast.hint')}
        onCheckedChange={(highContrast) => {
          savePreferenceOrToast({ highContrast });
        }}
      />
      <Switch
        checked={prefs.gravatar === true}
        label={t('prefs.gravatar')}
        hint={t('prefs.gravatar.hint')}
        onCheckedChange={(gravatar) => {
          savePreferenceOrToast({ gravatar });
        }}
      />
      <Row label={t('prefs.gravatar.clear')} hint={t('prefs.gravatar.clear.hint')}>
        <Button onClick={clearAvatars}>{t('prefs.gravatar.clear')}</Button>
      </Row>
      <Row label={t('prefs.density')}>
        <SegmentedControl<Density>
          label={t('prefs.density')}
          value={prefs.density}
          options={[
            { value: 'comfortable', label: t('prefs.density.comfortable') },
            { value: 'compact', label: t('prefs.density.compact') },
          ]}
          onChange={(density) => {
            savePreferenceOrToast({ density });
          }}
        />
      </Row>
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
      <Row label={t('prefs.uiFont')} hint={t('prefs.font.hint')} htmlFor={ids.ui}>
        <FontInput
          id={ids.ui}
          value={prefs.uiFont}
          onCommit={(uiFont) => {
            savePreferenceOrToast({ uiFont });
          }}
        />
      </Row>
      <Row label={t('prefs.codeFont')} htmlFor={ids.code}>
        <FontInput
          id={ids.code}
          mono
          value={prefs.codeFont}
          onCommit={(codeFont) => {
            savePreferenceOrToast({ codeFont });
          }}
        />
      </Row>
      <Row label={t('prefs.fontSize')} htmlFor={ids.size}>
        <input
          id={ids.size}
          type="range"
          className={styles.slider}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          value={prefs.fontSize}
          onChange={(event) => {
            savePreferenceOrToast({ fontSize: Number(event.target.value) });
          }}
        />
        <output htmlFor={ids.size} className={styles.value}>
          {t('prefs.fontSize.value', { size: prefs.fontSize })}
        </output>
      </Row>
    </>
  );
}

interface FontInputProps {
  id: string;
  value: string | null;
  mono?: boolean;
  onCommit: (value: string | null) => void;
}

/** Saved on Enter or when leaving the field, not on every keystroke. */
function FontInput({ id, value, mono, onCommit }: FontInputProps) {
  const t = useT();
  const [draft, setDraft] = useState(value ?? '');
  const commit = () => {
    const next = draft.trim() || null;
    if (next !== value) onCommit(next);
  };
  return (
    <TextInput
      id={id}
      mono={mono}
      value={draft}
      placeholder={t('prefs.font.placeholder')}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}
