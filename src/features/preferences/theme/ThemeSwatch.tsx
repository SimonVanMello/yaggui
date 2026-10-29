import styles from './ThemeSwatch.module.css';

/** Rows of the miniature graph: the lane of the dot and the length of the message. */
const ROWS = [
  [0, 1],
  [1, 0.7],
  [0, 0.85],
  [2, 0.6],
  [0, 0.9],
  [3, 0.5],
] as const;

interface ThemeSwatchProps {
  theme: string;
  size?: 'md' | 'sm';
}

/**
 * A miniature of the app in `theme`: titlebar, sidebar, graph and diff. It reads the theme's
 * own tokens (`data-theme` on the element), so it is exactly what the theme will show.
 */
export function ThemeSwatch({ theme, size = 'md' }: ThemeSwatchProps) {
  return (
    <div className={styles.swatch} data-theme={theme} data-size={size} aria-hidden="true">
      <div className={styles.titlebar} />
      <div className={styles.sidebar}>
        <i />
        <i data-on="" />
        <i />
        <i data-short="" />
      </div>
      <div className={styles.graph}>
        {ROWS.map(([lane, length], index) => (
          <div key={index} className={styles.row} data-selected={index === 1 ? '' : undefined}>
            <b style={{ background: `var(--lane-${String(lane)})` }} />
            <span style={{ flexGrow: length }} />
          </div>
        ))}
      </div>
      <div className={styles.diff}>
        <i data-kind="keyword" />
        <i />
        <i data-kind="del" />
        <i data-kind="add" />
        <i data-kind="add" />
      </div>
    </div>
  );
}
