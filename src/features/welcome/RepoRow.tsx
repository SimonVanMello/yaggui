import { useI18nStore } from '../../i18n/i18n';
import { formatRelativeTime } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import type { KnownRepo } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import { forgetKnownRepo, setFavorite } from '../repo/knownRepoActions';
import { repoColor } from '../repo/repoColor';
import { Highlight } from './Highlight';
import styles from './RepoRow.module.css';

interface RepoRowProps {
  repo: KnownRepo;
  id: string;
  selected: boolean;
  /** Shows the selection: only while browsing with the arrow keys, never left behind by the mouse. */
  active: boolean;
  nameIndices: readonly number[];
  pathIndices: readonly number[];
  now: number;
  onOpen: () => void;
  onPointer: () => void;
}

/** A known repository in the welcome screen list (option of the search listbox). */
export function RepoRow({
  repo,
  id,
  selected,
  active,
  nameIndices,
  pathIndices,
  now,
  onOpen,
  onPointer,
}: RepoRowProps) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const favoriteLabel = repo.favorite ? t('welcome.unfavorite') : t('welcome.favorite');

  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-active={active || undefined}
      data-missing={!repo.exists || undefined}
      className={styles.row}
      onClick={onOpen}
      onMouseMove={onPointer}
    >
      <span className={styles.dot} style={{ background: repoColor(repo.name) }} />
      <span className={styles.text}>
        <span className={styles.name}>
          <Highlight text={repo.name} indices={nameIndices} />
        </span>
        <span className={styles.path}>
          <Highlight text={repo.path} indices={pathIndices} />
        </span>
      </span>
      {repo.exists ? (
        <span className={styles.time}>
          {/* Imported by a folder scan, never opened yet. */}
          {repo.lastOpenedAt === 0
            ? t('welcome.neverOpened')
            : formatRelativeTime(repo.lastOpenedAt, now, locale)}
        </span>
      ) : (
        <span className={styles.missing}>
          <Icon name="warning" />
          {t('welcome.missing')}
        </span>
      )}
      <span className={styles.actions}>
        <Tooltip content={favoriteLabel}>
          <button
            type="button"
            tabIndex={-1}
            aria-label={favoriteLabel}
            aria-pressed={repo.favorite}
            className={styles.action}
            data-favorite={repo.favorite || undefined}
            onClick={(event) => {
              event.stopPropagation();
              void setFavorite(repo.id, !repo.favorite);
            }}
          >
            <Icon name="star" filled={repo.favorite} />
          </button>
        </Tooltip>
        <Tooltip content={t('welcome.forget')}>
          <button
            type="button"
            tabIndex={-1}
            aria-label={t('welcome.forgetNamed', { name: repo.name })}
            className={styles.action}
            onClick={(event) => {
              event.stopPropagation();
              void forgetKnownRepo(repo.id);
            }}
          >
            <Icon name="close" />
          </button>
        </Tooltip>
      </span>
    </div>
  );
}
