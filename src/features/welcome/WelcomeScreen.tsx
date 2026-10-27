import { useId, useMemo, useState, type KeyboardEvent } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useShellStore } from '../../app/shellStore';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, type KnownRepo } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { useShortcut } from '../keybindings/registry';
import { Spinner } from '../../ui/Spinner';
import { useNow } from '../../ui/useNow';
import { openRepoPath } from '../repo/repoSessions';
import { useKnownRepos } from '../repo/useKnownRepos';
import { fuzzyMatch } from './fuzzy';
import { useWorkspaceUi } from '../workspaces/workspaceStore';
import { WorkspacesSection } from '../workspaces/WorkspacesSection';
import { pickAndOpenRepo } from './openRepository';
import { RepoRow } from './RepoRow';
import styles from './WelcomeScreen.module.css';

interface Entry {
  repo: KnownRepo;
  score: number;
  nameIndices: number[];
  pathIndices: number[];
}

/** Name matches weigh more than path matches: people search for "yaggui", not "/Users". */
const NAME_WEIGHT = 2;

function search(repos: KnownRepo[], query: string): Entry[] {
  if (query.trim() === '') {
    return repos.map((repo) => ({ repo, score: 0, nameIndices: [], pathIndices: [] }));
  }
  const entries: Entry[] = [];
  for (const repo of repos) {
    const name = fuzzyMatch(query, repo.name);
    const path = fuzzyMatch(query, repo.path);
    if (!name && !path) continue;
    const nameScore = name ? name.score * NAME_WEIGHT : -Infinity;
    const pathScore = path ? path.score : -Infinity;
    entries.push({
      repo,
      score: Math.max(nameScore, pathScore),
      nameIndices: name && nameScore >= pathScore ? name.indices : [],
      pathIndices: path && pathScore > nameScore ? path.indices : [],
    });
  }
  return entries.sort((a, b) => b.score - a.score);
}

interface ActionTileProps {
  icon: IconName;
  title: string;
  description: string;
  shortcut?: string;
  soon?: boolean;
  onClick?: () => void;
}

function ActionTile({ icon, title, description, shortcut, soon, onClick }: ActionTileProps) {
  const t = useT();
  return (
    <button
      type="button"
      className={styles.tile}
      aria-disabled={soon || undefined}
      onClick={soon ? undefined : onClick}
    >
      <span className={styles.tileIcon}>
        <Icon name={icon} size="md" />
      </span>
      <span className={styles.tileText}>
        <span className={styles.tileTitle}>
          {title}
          {soon && <span className={styles.soon}>{t('common.soon')}</span>}
        </span>
        <span className={styles.tileDescription}>{description}</span>
      </span>
      {shortcut && <Kbd shortcut={shortcut} className={styles.tileKbd} />}
    </button>
  );
}

/** New tab / welcome screen (F-005): recent and favorite repos, fuzzy search, open actions. */
export function WelcomeScreen({ tabId }: { tabId: string }) {
  const t = useT();
  const openShortcut = useShortcut('repo.open');
  const listId = useId();
  const now = useNow();
  const known = useKnownRepos();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [highlighted, setHighlighted] = useState(false);

  const repos = useMemo(() => known.data ?? [], [known.data]);
  const results = useMemo(() => search(repos, query), [repos, query]);
  const searching = query.trim() !== '';
  const favorites = searching ? [] : results.filter((entry) => entry.repo.favorite);
  const recents = searching ? results : results.filter((entry) => !entry.repo.favorite);
  // Keyboard order follows the visual order: favorites first.
  const ordered = [...favorites, ...recents];
  const current = Math.min(selected, ordered.length - 1);

  const open = (repo: KnownRepo) => {
    // A moved or deleted folder cannot open: offer to locate it again or remove it (F-009).
    if (!repo.exists) {
      useWorkspaceUi.getState().showMissing(repo.id);
      return;
    }
    void openRepoPath(repo.path, tabId);
  };
  const pickFolder = () => {
    void pickAndOpenRepo(tabId);
  };
  const showOpenDialog = () => {
    useShellStore.getState().showOpenDialog(tabId);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = Math.max(0, Math.min(ordered.length - 1, current + step));
      setSelected(next);
      setHighlighted(true);
      document.getElementById(`${listId}-${String(next)}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      const entry = ordered[current];
      if (entry) open(entry.repo);
    } else if (event.key === 'Escape' && query) {
      event.preventDefault();
      setQuery('');
    }
  };

  const renderRows = (entries: Entry[], offset: number) =>
    entries.map((entry, index) => (
      <RepoRow
        key={entry.repo.id}
        id={`${listId}-${String(offset + index)}`}
        repo={entry.repo}
        selected={offset + index === current}
        active={highlighted && offset + index === current}
        nameIndices={entry.nameIndices}
        pathIndices={entry.pathIndices}
        now={now}
        onOpen={() => {
          open(entry.repo);
        }}
        onHover={() => {
          setSelected(offset + index);
          setHighlighted(true);
        }}
        onLeave={() => {
          setHighlighted(false);
        }}
      />
    ));

  let list;
  if (known.isPending) {
    list = (
      <div className={styles.placeholder}>
        <Spinner /> {t('welcome.loading')}
      </div>
    );
  } else if (known.error) {
    list = (
      <ErrorPanel
        compact
        title={t('welcome.loadFailed')}
        error={
          known.error instanceof YagguiIpcError
            ? known.error.error
            : {
                code: 'internal',
                message: { en: known.error.message, fr: known.error.message },
                action: null,
                detail: null,
                payload: null,
              }
        }
      >
        <Button
          size="sm"
          onClick={() => {
            void known.refetch();
          }}
        >
          <Icon name="retry" />
          {t('error.action.retry')}
        </Button>
      </ErrorPanel>
    );
  } else if (repos.length === 0) {
    list = (
      <div className={styles.empty}>
        <Icon name="folderOpen" size="lg" />
        <p>{t('welcome.empty')}</p>
      </div>
    );
  } else if (ordered.length === 0) {
    list = <div className={styles.placeholder}>{t('welcome.noMatch', { query })}</div>;
  } else {
    list = (
      <div
        id={listId}
        role="listbox"
        aria-label={t('welcome.repositories')}
        className={styles.list}
      >
        {favorites.length > 0 && (
          <div role="group" aria-label={t('welcome.favorites')} className={styles.group}>
            <div className={styles.groupTitle} aria-hidden="true">
              {t('welcome.favorites')}
            </div>
            {renderRows(favorites, 0)}
          </div>
        )}
        <div
          role="group"
          aria-label={searching ? t('welcome.results') : t('welcome.recents')}
          className={styles.group}
        >
          {recents.length > 0 && (
            <div className={styles.groupTitle} aria-hidden="true">
              {searching ? t('welcome.results') : t('welcome.recents')}
            </div>
          )}
          {renderRows(recents, favorites.length)}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <header className={styles.header}>
          <span className={styles.logo} aria-hidden="true">
            <Icon name="branch" size="lg" />
          </span>
          <div>
            <h1 className={styles.title}>{t('welcome.title')}</h1>
            <p className={styles.subtitle}>{t('welcome.subtitle')}</p>
          </div>
        </header>

        <div className={styles.tiles}>
          <ActionTile
            icon="folderOpen"
            title={t('welcome.open')}
            description={t('welcome.open.description')}
            shortcut={openShortcut}
            onClick={pickFolder}
          />
          <ActionTile
            icon="clone"
            title={t('welcome.clone')}
            description={t('welcome.clone.description')}
            onClick={() => {
              useShellStore.getState().showCloneDialog(tabId);
            }}
          />
          <ActionTile
            icon="init"
            title={t('welcome.init')}
            description={t('welcome.init.description')}
            onClick={() => {
              useShellStore.getState().showInitDialog(tabId);
            }}
          />
        </div>

        <WorkspacesSection tabId={tabId} />

        <div className={styles.search}>
          <Icon name="search" className={styles.searchIcon} />
          <input
            // The search field is the main entry point of the screen.
            autoFocus
            data-welcome-search
            type="search"
            role="combobox"
            aria-expanded={ordered.length > 0}
            aria-controls={listId}
            aria-activedescendant={ordered.length > 0 ? `${listId}-${String(current)}` : undefined}
            aria-label={t('welcome.search')}
            placeholder={t('welcome.search')}
            className={styles.searchInput}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
              setHighlighted(false);
            }}
            onKeyDown={onSearchKeyDown}
          />
          {ordered.length > 0 && <Kbd shortcut="Enter" className={styles.searchKbd} />}
        </div>

        {list}

        <p className={styles.dropHint}>
          <Icon name="drop" />
          {t('welcome.dropHint')}
          <span aria-hidden="true">·</span>
          <button type="button" className={styles.pathLink} onClick={showOpenDialog}>
            {t('welcome.openPath')}
          </button>
        </p>
      </div>
    </div>
  );
}
