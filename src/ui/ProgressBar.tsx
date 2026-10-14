import styles from './ProgressBar.module.css';

interface ProgressBarProps {
  /** 0–100; `null` for an indeterminate bar. */
  percent: number | null;
  label: string;
}

export function ProgressBar({ percent, label }: ProgressBarProps) {
  const known = percent !== null;
  return (
    <div
      className={styles.track}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? percent : undefined}
    >
      <div
        className={known ? styles.fill : `${styles.fill} ${styles.indeterminate}`}
        style={known ? { width: `${String(percent)}%` } : undefined}
      />
    </div>
  );
}
