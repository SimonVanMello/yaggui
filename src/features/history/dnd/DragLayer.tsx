import { createPortal } from 'react-dom';

import { Icon } from '../../../ui/Icon';
import { useDragStore } from './dragStore';
import styles from './Dnd.module.css';

/** The label that follows the pointer during a drag; purely visual. */
export function DragLayer() {
  const drag = useDragStore((state) => state.drag);
  if (!drag) return null;
  return createPortal(
    <div
      className={styles.ghost}
      style={{ transform: `translate(${String(drag.x + 14)}px, ${String(drag.y + 14)}px)` }}
      aria-hidden
    >
      <Icon name={drag.payload.kind === 'branch' ? 'branch' : 'commit'} />
      <span className={styles.ghostLabel}>{drag.label}</span>
    </div>,
    document.body,
  );
}
