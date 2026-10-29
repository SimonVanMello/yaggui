import { Dialog } from 'radix-ui';
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';

import { useShellStore } from '../../app/shellStore';
import { matchShortcut } from '../../ui/shortcuts';
import { useT } from '../../i18n/useT';
import { THEMES } from '../../theme/catalog';
import { useThemeStore } from '../../theme/themeStore';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { AppearanceSection } from './AppearanceSection';
import { DisplaySection } from './DisplaySection';
import { GeneralSection } from './GeneralSection';
import { GitConfigSection } from './GitConfigSection';
import { KeybindingsSection, commandTitles } from './KeybindingsSection';
import { SafetySection } from './SafetySection';
import { SyncSection } from './SyncSection';
import { ToolsSection } from './ToolsSection';
import {
  SECTIONS,
  SETTINGS,
  countBySection,
  isSectionId,
  searchSettings,
  type SectionId,
  type SectionInfo,
} from './settingsIndex';
import { SettingsFilterContext, type SettingsFilter } from './settingsFilter';
import { themeSearchText } from './theme/ThemeGallery';
import styles from './PreferencesDialog.module.css';

const CONTENT: Record<SectionId, ComponentType> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  display: DisplaySection,
  keybindings: KeybindingsSection,
  tools: ToolsSection,
  sync: SyncSection,
  safety: SafetySection,
  gitconfig: GitConfigSection,
};

const DEFAULT_SECTION: SectionId = 'general';

function sectionInfo(id: SectionId): SectionInfo {
  const info = SECTIONS.find((s) => s.id === id);
  if (!info) throw new Error(`unknown section ${id}`);
  return info;
}
const SHOW_ALL: SettingsFilter = { query: '', found: null };

/**
 * Preferences (F-320…F-326): sections in a sidebar, a search over every setting, and every
 * change applied and saved at once.
 */
export function PreferencesDialog() {
  const open = useShellStore((state) => state.preferencesOpen);
  const requested = useShellStore((state) => state.preferencesTab);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        useShellStore.getState().setPreferencesOpen(next);
      }}
    >
      {open && <PreferencesContent key={requested ?? ''} requested={requested} />}
    </Dialog.Root>
  );
}

function PreferencesContent({ requested }: { requested: string | null }) {
  const t = useT();
  const [section, setSection] = useState<SectionId>(
    isSectionId(requested) ? requested : DEFAULT_SECTION,
  );
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Setting to bring into view once its section is shown. */
  const reveal = useRef<string | null>(null);

  const extra = useMemo(
    () => ({
      theme: THEMES.map((theme) =>
        themeSearchText(theme, t(`prefs.theme.family.${theme.family}`)),
      ).join(' '),
      keybindings: commandTitles().join(' '),
    }),
    [t],
  );
  const trimmed = query.trim();
  const found = useMemo(() => searchSettings(trimmed, extra), [trimmed, extra]);
  const counts = useMemo(() => (found ? countBySection(found) : null), [found]);
  const filter: SettingsFilter = found ? { query: trimmed, found } : SHOW_ALL;

  const searching = found !== null;
  // A new page starts at the top, or at the setting a search result pointed to.
  useEffect(() => {
    const id = reveal.current;
    reveal.current = null;
    const row = id ? bodyRef.current?.querySelector<HTMLElement>(`[data-setting="${id}"]`) : null;
    if (!row) {
      if (bodyRef.current) bodyRef.current.scrollTop = 0;
      return;
    }
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
    row.dataset.flash = '';
    const timer = setTimeout(() => {
      delete row.dataset.flash;
    }, 1500);
    return () => {
      clearTimeout(timer);
    };
  }, [section, searching]);

  const goTo = (id: SectionId, setting: string | null = null) => {
    reveal.current = setting;
    setQuery('');
    setSection(id);
  };

  const info = sectionInfo(section);
  const groupLabel = (s: SectionInfo) =>
    t(s.group === 'app' ? 'prefs.group.app' : 'prefs.group.git');
  const Content = CONTENT[section];

  return (
    <Dialog.Portal>
      <Dialog.Overlay className={styles.overlay} />
      <Dialog.Content
        className={styles.content}
        data-modal=""
        onKeyDown={(event) => {
          if (matchShortcut(event.nativeEvent, 'Mod+F')) {
            event.preventDefault();
            event.stopPropagation();
            searchRef.current?.focus();
            searchRef.current?.select();
          }
        }}
        onEscapeKeyDown={(event) => {
          // Escape cancels the shortcut being captured, not the whole dialog.
          if (document.querySelector('[data-capturing]')) {
            event.preventDefault();
            return;
          }
          // Then it ends a theme preview, then it clears the search.
          const theme = useThemeStore.getState();
          if (theme.preview !== null) {
            event.preventDefault();
            theme.setPreview(null);
            return;
          }
          if (query !== '' && document.activeElement === searchRef.current) {
            event.preventDefault();
            setQuery('');
          }
        }}
      >
        <nav className={styles.nav} aria-label={t('prefs.sections')}>
          <Dialog.Title className={styles.title}>{t('prefs.title')}</Dialog.Title>
          <div className={styles.search}>
            <Icon name="search" className={styles.searchIcon} />
            <input
              ref={searchRef}
              type="search"
              className={styles.searchInput}
              value={query}
              placeholder={t('prefs.search.placeholder')}
              aria-label={t('prefs.search')}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
            {query ? (
              <button
                type="button"
                className={styles.clear}
                aria-label={t('prefs.search.clear')}
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
              >
                <Icon name="close" />
              </button>
            ) : (
              <Kbd shortcut="Mod+F" />
            )}
          </div>
          {(['app', 'git'] as const).map((group) => (
            <div key={group} className={styles.group}>
              <div className={styles.groupTitle}>
                {t(group === 'app' ? 'prefs.group.app' : 'prefs.group.git')}
              </div>
              {SECTIONS.filter((s) => s.group === group).map((s) => {
                const count = counts?.get(s.id) ?? 0;
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={styles.item}
                    aria-current={!found && s.id === section ? 'page' : undefined}
                    data-dim={found && count === 0 ? '' : undefined}
                    onClick={() => {
                      goTo(s.id);
                    }}
                  >
                    <Icon name={s.icon} />
                    <span className={styles.itemLabel}>{t(s.label)}</span>
                    {found && count > 0 && <span className={styles.count}>{count}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          <Dialog.Description className={styles.footnote}>
            {t('prefs.description')}
          </Dialog.Description>
        </nav>
        <section className={styles.pane} aria-labelledby="prefs-pane-title">
          <header className={styles.header}>
            {found ? (
              <h2 id="prefs-pane-title" className={styles.paneTitle}>
                {t('prefs.search.results')}
              </h2>
            ) : (
              <>
                <span className={styles.crumb}>{groupLabel(info)} ›</span>
                <h2 id="prefs-pane-title" className={styles.paneTitle}>
                  {t(info.label)}
                </h2>
              </>
            )}
            <span className={styles.spacer} />
            <Dialog.Close className={styles.close} aria-label={t('common.close')}>
              <Icon name="close" size="md" />
            </Dialog.Close>
          </header>
          <div ref={bodyRef} className={styles.body}>
            <div className={styles.inner}>
              {found ? (
                <SearchResults
                  query={trimmed}
                  found={found}
                  counts={counts}
                  onOpen={(id) => {
                    goTo(id, SETTINGS.find((s) => s.section === id && found.has(s.id))?.id);
                  }}
                />
              ) : (
                <>
                  <p className={styles.description}>{t(info.description)}</p>
                  <SettingsFilterContext.Provider value={filter}>
                    <Content />
                  </SettingsFilterContext.Provider>
                </>
              )}
            </div>
          </div>
        </section>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

interface SearchResultsProps {
  query: string;
  found: ReadonlySet<string>;
  counts: ReadonlyMap<SectionId, number> | null;
  onOpen: (section: SectionId) => void;
}

/** The matching settings of every section, each under the path to its section. */
function SearchResults({ query, found, counts, onOpen }: SearchResultsProps) {
  const t = useT();
  const sections = SECTIONS.filter((s) => (counts?.get(s.id) ?? 0) > 0);
  if (sections.length === 0) {
    return <p className={styles.description}>{t('prefs.search.empty', { query })}</p>;
  }
  return (
    <>
      <p className={styles.description} aria-live="polite">
        {t('prefs.search.count', { count: found.size, query })}
      </p>
      <SettingsFilterContext.Provider value={{ query, found }}>
        {sections.map((s) => {
          const Content = CONTENT[s.id];
          return (
            <section key={s.id} className={styles.result} aria-label={t(s.label)}>
              <div className={styles.resultPath}>
                <span>
                  {t(s.group === 'app' ? 'prefs.group.app' : 'prefs.group.git')} › {t(s.label)}
                </span>
                <button
                  type="button"
                  className={styles.open}
                  onClick={() => {
                    onOpen(s.id);
                  }}
                >
                  {t('prefs.search.open')}
                </button>
              </div>
              <Content />
            </section>
          );
        })}
      </SettingsFilterContext.Provider>
    </>
  );
}
