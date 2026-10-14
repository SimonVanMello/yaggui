import { useState, type ReactNode } from 'react';
import { create } from 'zustand';

import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { DiffTarget } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Spinner } from '../../ui/Spinner';
import { useDiffImage } from './diffQueries';
import { formatBytes } from './format';
import styles from './ImageDiff.module.css';

export type ImageDiffMode = 'side' | 'onion' | 'swipe';

/** The comparison mode is kept for the session, from one image to the next. */
const useImageMode = create<{ mode: ImageDiffMode }>(() => ({ mode: 'side' }));

interface Size {
  width: number;
  height: number;
}

function Picture({
  src,
  alt,
  onSize,
  className,
  style,
}: {
  src: string;
  alt: string;
  onSize?: (size: Size) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  // An SVG goes through `<img>` only: there it cannot run scripts nor load anything.
  return (
    <img
      src={src}
      alt={alt}
      draggable={false}
      className={className}
      style={style}
      onLoad={(event) => {
        const image = event.currentTarget;
        onSize?.({ width: image.naturalWidth, height: image.naturalHeight });
      }}
    />
  );
}

function Caption({
  label,
  size,
  bytes,
}: {
  label: string;
  size: Size | null;
  bytes: number | null;
}) {
  const locale = useI18nStore((state) => state.locale);
  const parts = [
    size ? `${String(size.width)} × ${String(size.height)}` : null,
    bytes === null ? null : formatBytes(bytes, locale),
  ].filter((part): part is string => part !== null);
  return (
    <figcaption className={styles.caption}>
      <span className={styles.captionLabel}>{label}</span>
      {parts.length > 0 && <span className={styles.captionMeta}>{parts.join(' · ')}</span>}
    </figcaption>
  );
}

function Slider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className={styles.slider}>
      <span>{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        aria-valuetext={`${String(value)} %`}
        onChange={(event) => {
          onChange(Number(event.currentTarget.value));
        }}
      />
    </label>
  );
}

interface ImageDiffProps {
  repoId: number;
  target: DiffTarget;
  path: string;
  oldPath: string | null;
  /** Sizes in bytes, when the diff gave them (`null` = unknown or side absent). */
  oldSize: number | null;
  newSize: number | null;
  /** Shown when neither side can be displayed (too large, unreadable). */
  fallback: ReactNode;
  /** Extra controls in the image toolbar (e.g. "Source" for an SVG). */
  actions?: ReactNode;
}

/**
 * Image diff (F-085): side by side, onion skin (opacity) or swipe. Both sides come from the
 * backend as `data:` URLs (the CSP allows `img-src data:`).
 */
export function ImageDiff({
  repoId,
  target,
  path,
  oldPath,
  oldSize,
  newSize,
  fallback,
  actions,
}: ImageDiffProps) {
  const t = useT();
  const mode = useImageMode((state) => state.mode);
  const [opacity, setOpacity] = useState(50);
  const [swipe, setSwipe] = useState(50);
  const [sizes, setSizes] = useState<{ old: Size | null; new: Size | null }>({
    old: null,
    new: null,
  });
  const old = useDiffImage(repoId, target, path, oldPath, 'old');
  const now = useDiffImage(repoId, target, path, oldPath, 'new');

  if (old.isPending || now.isPending) {
    return (
      <div className={styles.centered} role="status">
        <Spinner />
      </div>
    );
  }
  const before = old.data ?? null;
  const after = now.data ?? null;
  if (before === null && after === null) return <>{fallback}</>;
  const both = before !== null && after !== null;
  const shown = both ? mode : 'side';
  const beforeLabel = t('diff.before');
  const afterLabel = t('diff.after');

  let stage;
  if (shown === 'side' || !both) {
    stage = (
      <div className={styles.sideBySide} data-single={!both || undefined}>
        {before !== null && (
          <figure className={styles.figure} data-side="old">
            <div className={styles.frame}>
              <Picture
                src={before}
                alt={t('diff.image.alt', { label: beforeLabel, path: oldPath ?? path })}
                className={styles.image}
                onSize={(size) => {
                  setSizes((s) => ({ ...s, old: size }));
                }}
              />
            </div>
            <Caption label={beforeLabel} size={sizes.old} bytes={oldSize} />
          </figure>
        )}
        {after !== null && (
          <figure className={styles.figure} data-side="new">
            <div className={styles.frame}>
              <Picture
                src={after}
                alt={t('diff.image.alt', { label: afterLabel, path })}
                className={styles.image}
                onSize={(size) => {
                  setSizes((s) => ({ ...s, new: size }));
                }}
              />
            </div>
            <Caption label={afterLabel} size={sizes.new} bytes={newSize} />
          </figure>
        )}
      </div>
    );
  } else {
    // Both pictures stacked at the same place; the new one fades in or is revealed.
    const overlay =
      shown === 'onion'
        ? { opacity: opacity / 100 }
        : { clipPath: `inset(0 0 0 ${String(swipe)}%)` };
    stage = (
      <figure className={styles.figure}>
        <div className={`${styles.frame} ${styles.stack}`}>
          <Picture
            src={before}
            alt={t('diff.image.alt', { label: beforeLabel, path: oldPath ?? path })}
            className={styles.image}
          />
          <Picture
            src={after}
            alt={t('diff.image.alt', { label: afterLabel, path })}
            className={`${styles.image} ${styles.overlay}`}
            style={overlay}
          />
          {shown === 'swipe' && (
            <span
              className={styles.swipeLine}
              style={{ left: `${String(swipe)}%` }}
              aria-hidden="true"
            />
          )}
        </div>
        {shown === 'onion' ? (
          <Slider label={t('diff.image.opacity')} value={opacity} onChange={setOpacity} />
        ) : (
          <Slider label={t('diff.image.swipe')} value={swipe} onChange={setSwipe} />
        )}
      </figure>
    );
  }

  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <Icon name="image" />
        <span className={styles.toolbarTitle}>
          {both
            ? t('diff.image.changed')
            : before === null
              ? t('diff.image.added')
              : t('diff.image.deleted')}
        </span>
        {both && (
          <SegmentedControl
            label={t('diff.image.mode')}
            value={mode}
            options={[
              { value: 'side', label: t('diff.image.side') },
              { value: 'onion', label: t('diff.image.onion') },
              { value: 'swipe', label: t('diff.image.swipeMode') },
            ]}
            onChange={(next) => {
              useImageMode.setState({ mode: next });
            }}
          />
        )}
        {actions}
      </div>
      <div className={styles.stage}>{stage}</div>
    </div>
  );
}
