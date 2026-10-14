import { useT } from '../../i18n/useT';
import type { FileDiff, LineEnding, TextDiff } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { modeOctal } from './format';
import styles from './DiffNotices.module.css';

const ENDING: Record<LineEnding, string> = {
  none: '—',
  lf: 'LF',
  crlf: 'CRLF',
  mixed: 'CRLF + LF',
};

function lineEndingChange(text: TextDiff): string | null {
  const { oldLineEnding: before, newLineEnding: after } = text;
  if (before === 'none' || after === 'none' || before === after) return null;
  return `${ENDING[before]} → ${ENDING[after]}`;
}

/**
 * What the code alone does not show (F-086): mode change, line endings, guessed encoding,
 * rename similarity.
 */
export function DiffNotices({
  diff,
  similarity,
  whitespaceIgnored = false,
}: {
  diff: FileDiff;
  similarity: number | null;
  /** "Ignore whitespace" is on: the line ending changes are already hidden. */
  whitespaceIgnored?: boolean;
}) {
  const t = useT();
  const notices: { key: string; icon: 'info' | 'warning'; text: string }[] = [];
  if (diff.oldPath && diff.oldPath !== diff.path) {
    notices.push({
      key: 'rename',
      icon: 'info',
      text:
        similarity === null
          ? t('diff.notice.renamed', { from: diff.oldPath })
          : t('diff.notice.renamedSimilar', { from: diff.oldPath, similarity }),
    });
  }
  const { oldMode, newMode } = diff;
  if (oldMode && newMode && oldMode !== newMode) {
    notices.push({
      key: 'mode',
      icon: 'info',
      text: t('diff.notice.mode', { from: modeOctal(oldMode), to: modeOctal(newMode) }),
    });
  }
  if (diff.content.kind === 'text') {
    const endings = lineEndingChange(diff.content);
    if (endings) {
      notices.push({
        key: 'eol',
        icon: 'warning',
        text: t(whitespaceIgnored ? 'diff.notice.lineEndingsHidden' : 'diff.notice.lineEndings', {
          change: endings,
        }),
      });
    } else if (diff.content.newLineEnding === 'mixed') {
      notices.push({ key: 'eol', icon: 'warning', text: t('diff.notice.mixedEndings') });
    }
    if (diff.content.oldEncoding !== 'utf8' || diff.content.newEncoding !== 'utf8') {
      notices.push({ key: 'encoding', icon: 'warning', text: t('diff.notice.encoding') });
    }
  }
  if (notices.length === 0) return null;
  return (
    <ul className={styles.notices}>
      {notices.map((notice) => (
        <li key={notice.key} className={styles.notice} data-tone={notice.icon}>
          <Icon name={notice.icon} />
          {notice.text}
        </li>
      ))}
    </ul>
  );
}
