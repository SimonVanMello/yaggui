import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { DEFAULT_ZOOM, resetZoom, stepZoom, zoomIn, zoomOut } from '../zoom/zoom';
import styles from './ZoomControl.module.css';

/** − / percent / + / Reset of the interface zoom (Preferences › Display). */
export function ZoomControl({ zoom }: { zoom: number }) {
  const t = useT();
  return (
    <div className={styles.control}>
      <Button
        size="sm"
        aria-label={t('prefs.zoom.out')}
        disabled={stepZoom(zoom, -1) === zoom}
        onClick={zoomOut}
      >
        <Icon name="minus" size="sm" />
      </Button>
      <output className={styles.value} aria-live="polite" data-testid="zoom-value">
        {t('prefs.zoom.value', { percent: zoom })}
      </output>
      <Button
        size="sm"
        aria-label={t('prefs.zoom.in')}
        disabled={stepZoom(zoom, 1) === zoom}
        onClick={zoomIn}
      >
        <Icon name="plus" size="sm" />
      </Button>
      <Button size="sm" disabled={zoom === DEFAULT_ZOOM} onClick={resetZoom}>
        {t('prefs.zoom.reset')}
      </Button>
    </div>
  );
}
