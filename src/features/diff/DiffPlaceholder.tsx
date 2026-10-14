import type { ReactNode } from 'react';

import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { DiffContent, LfsObject } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import type { EmptyDiffReason } from './emptyDiff';
import { formatBytes, modeOctal, shortSha } from './format';
import styles from './DiffPlaceholder.module.css';

function Panel({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className={styles.panel} role="status">
      <Icon name={icon} size="lg" className={styles.icon} />
      <p className={styles.title}>{title}</p>
      {children}
    </div>
  );
}

function Sizes({ before, after }: { before: string | null; after: string | null }) {
  const t = useT();
  return (
    <dl className={styles.sizes}>
      <div>
        <dt>{t('diff.before')}</dt>
        <dd>{before ?? '—'}</dd>
      </div>
      <span className={styles.arrow} aria-hidden="true">
        →
      </span>
      <div>
        <dt>{t('diff.after')}</dt>
        <dd>{after ?? '—'}</dd>
      </div>
    </dl>
  );
}

function lfsSide(
  side: LfsObject | null,
  size: (bytes: number | null) => string | null,
  local: string,
) {
  if (!side) return null;
  const id = side.oid ? side.oid.replace(/^sha256:/, '').slice(0, 10) : local;
  return `${size(side.size) ?? ''} · ${id}`;
}

/**
 * Every diff that is not rendered as code: binary, too large, submodule, LFS, conflict, no
 * change. `actions`: what the feature of a submodule or LFS file offers below it.
 */
export function DiffPlaceholder({
  content,
  isImage,
  onForce,
  actions,
  empty = { kind: 'none' },
  onShowWhitespace,
}: {
  content: DiffContent | null;
  isImage: boolean;
  onForce: () => void;
  actions?: ReactNode;
  /** Why a text diff has no hunk (F-086). */
  empty?: EmptyDiffReason;
  /** Turns "Ignore whitespace" off. */
  onShowWhitespace?: () => void;
}) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const size = (bytes: number | null) => (bytes === null ? null : formatBytes(bytes, locale));

  if (content === null) return <Panel icon="check" title={t('diff.noChange')} />;
  switch (content.kind) {
    case 'binary':
      return (
        <Panel icon={isImage ? 'image' : 'file'} title={t(isImage ? 'diff.image' : 'diff.binary')}>
          <Sizes before={size(content.oldSize)} after={size(content.newSize)} />
          {isImage && <p className={styles.text}>{t('diff.image.tooLarge')}</p>}
        </Panel>
      );
    case 'tooLarge':
      return (
        <Panel icon="warning" title={t('diff.tooLarge')}>
          <p className={styles.text}>
            {content.lines === null
              ? t('diff.tooLargeSize', {
                  size: size(Math.max(content.oldSize ?? 0, content.newSize ?? 0)) ?? '',
                })
              : t('diff.tooLargeText', { lines: content.lines })}
          </p>
          <Button onClick={onForce}>{t('diff.showAnyway')}</Button>
        </Panel>
      );
    case 'submodule':
      return (
        <Panel icon="folder" title={t('diff.submodule')}>
          <Sizes
            before={content.oldCommit ? shortSha(content.oldCommit) : null}
            after={content.newCommit ? shortSha(content.newCommit) : null}
          />
          {actions}
        </Panel>
      );
    case 'lfs':
      return (
        <Panel icon="file" title={t('diff.lfs')}>
          <Sizes
            before={lfsSide(content.old, size, t('diff.lfsLocal'))}
            after={lfsSide(content.new, size, t('diff.lfsLocal'))}
          />
          <p className={styles.text}>{t('diff.lfsText')}</p>
          {actions}
        </Panel>
      );
    case 'conflict':
      return (
        <Panel icon="error" title={t('diff.conflict')}>
          <p className={styles.text}>{t('diff.conflictText')}</p>
        </Panel>
      );
    case 'text':
      switch (empty.kind) {
        case 'mode':
          return (
            <Panel icon="info" title={t('diff.empty.mode')}>
              <p className={styles.text}>
                {t('diff.empty.modeText', {
                  from: modeOctal(empty.from),
                  to: modeOctal(empty.to),
                })}
              </p>
            </Panel>
          );
        case 'lineEndings':
        case 'whitespace':
          return (
            <Panel
              icon="info"
              title={t(
                empty.kind === 'lineEndings' ? 'diff.empty.lineEndings' : 'diff.empty.whitespace',
              )}
            >
              <p className={styles.text}>
                {t(
                  empty.kind === 'lineEndings'
                    ? 'diff.empty.lineEndingsText'
                    : 'diff.empty.whitespaceText',
                )}
              </p>
              {onShowWhitespace && (
                <Button onClick={onShowWhitespace}>{t('diff.empty.showWhitespace')}</Button>
              )}
            </Panel>
          );
        case 'none':
          return <Panel icon="check" title={t('diff.noChange')} />;
      }
  }
}
