import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { ConflictResolution, ConflictSide, ConflictVersions } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { formatBytes } from '../diff/format';
import { choiceAction, sideChange, sideResolution } from './choiceModel';
import { useConflictImage } from './conflictQueries';
import type { SideTitle } from './MergeEditor';
import type { Side } from './mergeModel';
import styles from './ChoiceConflict.module.css';

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i;
/** Lines of a text version shown in its card. */
const PREVIEW_LINES = 40;

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

function Preview({
  repoId,
  path,
  side,
  version,
}: {
  repoId: number;
  path: string;
  side: Side;
  version: ConflictSide;
}) {
  const t = useT();
  const image = IMAGE.test(path);
  const query = useConflictImage(repoId, path, side, image);
  if (image && query.data) {
    return (
      <div className={styles.image}>
        <img src={query.data} alt={t('conflicts.editor.choice.imageAlt', { path })} />
      </div>
    );
  }
  if (version.text === null) {
    return (
      <div className={styles.empty}>
        <Icon name={image ? 'image' : 'file'} size="lg" />
        <span>
          {t(image ? 'conflicts.editor.choice.noPreview' : 'conflicts.editor.choice.binary')}
        </span>
      </div>
    );
  }
  const lines = version.text.split('\n');
  const shown = lines.slice(0, PREVIEW_LINES).join('\n');
  return (
    <pre className={styles.text} aria-label={t('conflicts.editor.choice.preview')}>
      {shown}
      {lines.length > PREVIEW_LINES && <span className={styles.more}>{'\n…'}</span>}
    </pre>
  );
}

function Card({
  repoId,
  versions,
  side,
  title,
  busy,
  onResolve,
}: {
  repoId: number;
  versions: ConflictVersions;
  side: Side;
  title: SideTitle;
  busy: boolean;
  onResolve: (resolution: ConflictResolution) => void;
}) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const version = versions[side];
  const change = sideChange(versions, side);
  const action = choiceAction(versions, side);
  return (
    <section className={styles.card} data-side={side} aria-label={title.name}>
      <header className={styles.header}>
        <span className={styles.dot} aria-hidden />
        <strong className={styles.name}>{title.name}</strong>
        <span className={styles.role}>{title.role}</span>
      </header>
      {title.commit && <p className={styles.commit}>{title.commit}</p>}
      <p className={styles.change} data-change={change}>
        {t(`conflicts.editor.change.${change}`)}
      </p>
      {version ? (
        <>
          <dl className={styles.meta}>
            <div>
              <dt>{t('conflicts.editor.choice.size')}</dt>
              <dd>{formatBytes(version.size, locale)}</dd>
            </div>
            <div>
              <dt>{t('conflicts.editor.choice.type')}</dt>
              <dd>
                {version.binary
                  ? t('conflicts.editor.choice.binary')
                  : t('conflicts.editor.choice.lines', { count: lineCount(version.text ?? '') })}
              </dd>
            </div>
          </dl>
          <Preview repoId={repoId} path={versions.path} side={side} version={version} />
        </>
      ) : (
        <div className={styles.empty}>
          <Icon name="trash" size="lg" />
          <span>{t('conflicts.editor.choice.noFile')}</span>
        </div>
      )}
      <Button
        variant={action === 'acceptDeletion' || action === 'dropFile' ? 'danger' : 'primary'}
        disabled={busy}
        className={styles.action}
        onClick={() => {
          onResolve(sideResolution(side));
        }}
      >
        {t(`conflicts.editor.choice.${action}`, { name: title.name })}
      </Button>
    </section>
  );
}

interface ChoiceConflictProps {
  repoId: number;
  versions: ConflictVersions;
  titles: Record<Side, SideTitle>;
  busy: boolean;
  onResolve: (resolution: ConflictResolution) => void;
}

/**
 * Deletion against modification, file on one side only, or binary file (F-165): no line
 * merge, an explicit choice between the two sides with what each one did.
 */
export function ChoiceConflict({ repoId, versions, titles, busy, onResolve }: ChoiceConflictProps) {
  const t = useT();
  const binary = [versions.ours, versions.theirs, versions.base].some((v) => v?.binary === true);
  const kind = versions.kind ?? 'content';
  const situation =
    kind === 'content' || kind === 'bothAdded' ? (binary ? 'binary' : 'content') : kind;
  return (
    <div className={styles.choice}>
      <div className={styles.intro}>
        <Icon name="warning" className={styles.introIcon} />
        <p>
          {t(`conflicts.editor.situation.${situation}`, {
            ours: titles.ours.name,
            theirs: titles.theirs.name,
          })}
        </p>
      </div>
      <div className={styles.cards}>
        {(['ours', 'theirs'] as const).map((side) => (
          <Card
            key={side}
            repoId={repoId}
            versions={versions}
            side={side}
            title={titles[side]}
            busy={busy}
            onResolve={onResolve}
          />
        ))}
      </div>
    </div>
  );
}
