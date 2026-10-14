import type { ConflictResolution, ConflictVersions } from '../../ipc';
import type { Side } from './mergeModel';

/** A content conflict between two text versions: the 3-way editor handles it. */
export function isTextConflict(versions: ConflictVersions): boolean {
  const { kind, base, ours, theirs } = versions;
  return (
    (kind === 'content' || kind === 'bothAdded') &&
    ours !== null &&
    theirs !== null &&
    !ours.binary &&
    !theirs.binary &&
    !(base?.binary ?? false)
  );
}

/** What a side did to the file, from whether it and the base have it. */
export type SideChange = 'modified' | 'added' | 'deleted' | 'absent';

export function sideChange(versions: ConflictVersions, side: Side): SideChange {
  const present = versions[side] !== null;
  const inBase = versions.base !== null;
  if (present) return inBase ? 'modified' : 'added';
  return inBase ? 'deleted' : 'absent';
}

/**
 * The resolution the card of `side` applies: always that side's version (`ours` / `theirs`),
 * which the backend turns into a deletion when the side deleted the file.
 */
export function sideResolution(side: Side): ConflictResolution {
  return { kind: side };
}

/** Label of the card's button, from what keeping that side means. */
export function choiceAction(
  versions: ConflictVersions,
  side: Side,
): 'take' | 'keepModified' | 'keepAdded' | 'acceptDeletion' | 'dropFile' {
  const change = sideChange(versions, side);
  const other = sideChange(versions, side === 'ours' ? 'theirs' : 'ours');
  if (change === 'deleted') return 'acceptDeletion';
  if (change === 'absent') return 'dropFile';
  if (other === 'deleted' || other === 'absent') {
    return change === 'modified' ? 'keepModified' : 'keepAdded';
  }
  return 'take';
}
