import { splitCode } from './changelog';
import styles from './ChangelogDialog.module.css';

/** An entry as text, with its `code` spans: no Markdown is rendered as HTML. */
export function ChangelogText({ text }: { text: string }) {
  return (
    <>
      {splitCode(text).map((segment, index) =>
        segment.code ? (
          <code key={index} className={styles.code}>
            {segment.text}
          </code>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
