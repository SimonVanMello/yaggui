import type { TextDiff } from '../../../ipc';

/** Both versions of a file, from a diff computed over the whole file (`fullFile`). */
export function textSides(diff: TextDiff): { old: string; new: string } {
  const old: string[] = [];
  const next: string[] = [];
  for (const hunk of diff.hunks) {
    hunk.lines.forEach((line, index) => {
      const kind = hunk.kinds[index];
      if (kind !== '+') old.push(line);
      if (kind !== '-') next.push(line);
    });
  }
  return { old: old.join('\n'), new: next.join('\n') };
}
