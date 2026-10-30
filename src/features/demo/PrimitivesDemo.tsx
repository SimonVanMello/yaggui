import { useState } from 'react';

import { useAppInfo } from '../../app/useAppInfo';
import { locales, useI18nStore, type Locale } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { useThemeStore, type ThemePreference } from '../../theme/themeStore';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Menu } from '../../ui/Menu';
import { MenuItem } from '../../ui/MenuItem';
import { MenuLabel } from '../../ui/MenuLabel';
import { MenuSeparator } from '../../ui/MenuSeparator';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { toast } from '../../ui/toastStore';
import { DemoSection } from './DemoSection';
import styles from './PrimitivesDemo.module.css';
import { ShortcutList } from './ShortcutList';

/** Unbreakable string longer than a tooltip's max width: it must wrap inside the box. */
const LONG_PATH = '/Users/alex/git/clients/acme/nyx_rest_acme_external_integration_service';

const LOCALE_LABELS: Record<Locale, string> = { en: 'English', fr: 'Français' };

/** Showcase of the `ui/` primitives, used as the M0-1 home page and for visual tests. */
export function PrimitivesDemo() {
  const t = useT();
  const appInfo = useAppInfo();
  const preference = useThemeStore((state) => state.preference);
  const setPreference = useThemeStore((state) => state.setPreference);
  const locale = useI18nStore((state) => state.locale);
  const setLocale = useI18nStore((state) => state.setLocale);
  const [dialogOpen, setDialogOpen] = useState(false);

  const themeOptions: { value: ThemePreference; label: string }[] = [
    { value: 'light', label: t('settings.theme.light') },
    { value: 'dark', label: t('settings.theme.dark') },
    { value: 'system', label: t('settings.theme.system') },
  ];
  const localeOptions = locales.map((value) => ({ value, label: LOCALE_LABELS[value] }));

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <h1 className={styles.title}>{t('demo.title')}</h1>
          <p className={styles.subtitle}>{t('demo.subtitle')}</p>
        </div>
        <div className={styles.settings}>
          <div className={styles.setting}>
            {t('settings.theme')}
            <SegmentedControl
              label={t('settings.theme')}
              value={preference}
              options={themeOptions}
              onChange={setPreference}
            />
          </div>
          <div className={styles.setting}>
            {t('settings.language')}
            <SegmentedControl
              label={t('settings.language')}
              value={locale}
              options={localeOptions}
              onChange={setLocale}
            />
          </div>
        </div>
      </header>

      <main className={styles.content}>
        <p className={styles.appInfo} data-testid="app-info">
          {appInfo.data
            ? t('demo.appInfo', {
                appVersion: appInfo.data.appVersion,
                gitVersion: appInfo.data.gitVersion ?? t('demo.gitMissing'),
              })
            : t('demo.appInfoLoading')}
        </p>

        <DemoSection title={t('demo.section.buttons')}>
          <Button variant="primary">
            <Icon name="check" />
            {t('demo.button.primary')}
          </Button>
          <Button variant="secondary">{t('demo.button.secondary')}</Button>
          <Button variant="ghost">{t('demo.button.ghost')}</Button>
          <Button variant="danger">{t('demo.button.danger')}</Button>
          <Button variant="primary" disabled>
            {t('demo.button.disabled')}
          </Button>
          <Button variant="secondary" size="sm">
            {t('demo.button.small')}
          </Button>
        </DemoSection>

        <DemoSection title={t('demo.section.iconButtons')}>
          <IconButton icon="fetch" label={t('icon.fetch')} />
          <IconButton icon="pull" label={t('icon.pull')} />
          <IconButton icon="push" label={t('icon.push')} shortcut="Mod+Shift+P" />
          <IconButton icon="branch" label={t('icon.branch')} shortcut="Mod+B" />
          <IconButton icon="settings" label={t('icon.settings')} aria-pressed />
          <IconButton icon="trash" label={t('demo.button.danger')} size="sm" disabled />
          <IconButton icon="folder" label={LONG_PATH} shortcut="Mod+Shift+O" />
        </DemoSection>

        <DemoSection title={t('demo.section.kbd')}>
          <ShortcutList />
        </DemoSection>

        <DemoSection title={t('demo.section.overlays')}>
          <Menu
            trigger={
              <Button variant="secondary">
                {t('demo.menu.open')}
                <Icon name="chevronDown" />
              </Button>
            }
          >
            <MenuLabel>{t('demo.menu.label')}</MenuLabel>
            <MenuItem icon="check" hint="git switch feat/graph">
              {t('demo.menu.checkout')}
            </MenuItem>
            <MenuItem icon="merge" hint="git merge feat/graph" shortcut="Mod+M">
              {t('demo.menu.merge')}
            </MenuItem>
            <MenuItem icon="branch" disabled>
              {t('demo.menu.rebase')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon="trash" danger>
              {t('demo.menu.delete')}
            </MenuItem>
          </Menu>

          <Button
            variant="secondary"
            onClick={() => {
              setDialogOpen(true);
            }}
          >
            {t('demo.dialog.open')}
          </Button>
          <Dialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            title={t('demo.dialog.title')}
            description={t('demo.dialog.description')}
            footer={
              <>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDialogOpen(false);
                  }}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    setDialogOpen(false);
                  }}
                >
                  {t('demo.dialog.confirm')}
                </Button>
              </>
            }
          />

          <Button
            variant="secondary"
            onClick={() => {
              toast({
                variant: 'success',
                title: t('demo.toast.title'),
                description: t('demo.toast.description'),
              });
            }}
          >
            {t('demo.toast.open')}
          </Button>
        </DemoSection>
      </main>
    </div>
  );
}
