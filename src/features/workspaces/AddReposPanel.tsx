import { useMemo, useState } from 'react';

import { useT } from '../../i18n/useT';
import type { KnownRepo } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { TextInput } from '../../ui/TextInput';
import { fuzzyMatch } from '../welcome/fuzzy';
import styles from './AddReposPanel.module.css';

/** Candidates shown at most: the search narrows down a long list of known repos. */
const MAX_SHOWN = 50;

interface AddReposPanelProps {
  candidates: readonly KnownRepo[];
  onAdd: (repoId: number) => void;
  onScan: () => void;
  onClose: () => void;
}

/** Inline picker of known repos to add to a workspace, with the folder scan as a way out. */
export function AddReposPanel({ candidates, onAdd, onScan, onClose }: AddReposPanelProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const text = query.trim();
    const matches = text
      ? candidates.filter((repo) => fuzzyMatch(text, repo.name) ?? fuzzyMatch(text, repo.path))
      : candidates;
    return matches.slice(0, MAX_SHOWN);
  }, [candidates, query]);

  return (
    <div className={styles.panel}>
      <div className={styles.bar}>
        <TextInput
          // Opened on demand to pick a repo: the search is what comes next.
          autoFocus
          type="search"
          aria-label={t('workspace.add.search')}
          placeholder={t('workspace.add.search')}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        />
        <Button size="sm" onClick={onScan}>
          <Icon name="search" />
          {t('workspace.scanFolder')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
      {shown.length === 0 ? (
        <p className={styles.empty}>
          {candidates.length === 0 ? t('workspace.add.none') : t('workspace.add.noMatch')}
        </p>
      ) : (
        <ul className={styles.list} aria-label={t('workspace.addKnown')}>
          {shown.map((repo) => (
            <li key={repo.id} className={styles.item}>
              <span className={styles.text}>
                <span className={styles.name}>{repo.name}</span>
                <span className={styles.path}>{repo.path}</span>
              </span>
              <Button
                size="sm"
                aria-label={t('workspace.add.named', { name: repo.name })}
                onClick={() => {
                  onAdd(repo.id);
                }}
              >
                <Icon name="plus" />
                {t('workspace.add.button')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
