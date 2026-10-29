import { useEffect, useId, useRef } from 'react';

import { usePreferences } from '../../app/usePreferences';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, YagguiIpcError, type Density } from '../../ipc';
import { Button } from '../../ui/Button';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Switch } from '../../ui/Switch';
import { toast } from '../../ui/toastStore';
import { clearGravatarCache } from '../graph/gravatar';
import { FontInput } from './FontInput';
import { savePreferenceOrToast } from './savePreference';
import { Row } from './Row';
import { Setting } from './Setting';
import { SettingGroup } from './SettingGroup';
import { useDraft } from './useDraft';
import styles from './DisplaySection.module.css';

/** A drag of the text size slider fires a change per step: one save once it settles. */
const FONT_SIZE_SAVE_DELAY_MS = 150;

/** Fonts, text size, density and avatars (F-320, F-033). */
export function DisplaySection() {
  const t = useT();
  const prefs = usePreferences();
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
  const [fontSize, setFontSize] = useDraft(String(prefs.fontSize));
  const pendingFontSize = useRef<{ size: number; timer: ReturnType<typeof setTimeout> } | null>(
    null,
  );
  const changeFontSize = (size: number) => {
    setFontSize(String(size));
    if (pendingFontSize.current) clearTimeout(pendingFontSize.current.timer);
    const timer = setTimeout(() => {
      pendingFontSize.current = null;
      savePreferenceOrToast({ fontSize: size });
    }, FONT_SIZE_SAVE_DELAY_MS);
    pendingFontSize.current = { size, timer };
  };
  // A size still pending when the dialog closes is saved rather than lost.
  useEffect(
    () => () => {
      const pending = pendingFontSize.current;
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingFontSize.current = null;
      savePreferenceOrToast({ fontSize: pending.size });
    },
    [],
  );

  return (
    <>
      <SettingGroup
        title={t('prefs.subsection.text')}
        ids={['uiFont', 'codeFont', 'fontSize', 'density']}
      >
        <Setting id="uiFont">
          <Row label={t('prefs.uiFont')} hint={t('prefs.font.hint')} htmlFor={ids.ui}>
            <FontInput
              id={ids.ui}
              value={prefs.uiFont}
              onCommit={(uiFont) => {
                savePreferenceOrToast({ uiFont });
              }}
            />
          </Row>
        </Setting>
        <Setting id="codeFont">
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
        </Setting>
        <Setting id="fontSize">
          <Row label={t('prefs.fontSize')} htmlFor={ids.size}>
            <input
              id={ids.size}
              type="range"
              className={styles.slider}
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              step={1}
              value={fontSize}
              onChange={(event) => {
                changeFontSize(Number(event.target.value));
              }}
            />
            <output htmlFor={ids.size} className={styles.value}>
              {t('prefs.fontSize.value', { size: Number(fontSize) })}
            </output>
          </Row>
        </Setting>
        <Setting id="density">
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
        </Setting>
      </SettingGroup>
      <SettingGroup title={t('prefs.subsection.avatars')} ids={['gravatar', 'gravatarCache']}>
        <Setting id="gravatar">
          <Switch
            checked={prefs.gravatar === true}
            label={t('prefs.gravatar')}
            hint={t('prefs.gravatar.hint')}
            onCheckedChange={(gravatar) => {
              savePreferenceOrToast({ gravatar });
            }}
          />
        </Setting>
        <Setting id="gravatarCache">
          <Row label={t('prefs.gravatar.clear')} hint={t('prefs.gravatar.clear.hint')}>
            <Button onClick={clearAvatars}>{t('prefs.gravatar.clear')}</Button>
          </Row>
        </Setting>
      </SettingGroup>
    </>
  );
}
