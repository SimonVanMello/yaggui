import type { FileMode, FileStatus, Locale } from '../../ipc';

const OCTAL: Record<FileMode, string> = {
  regular: '100644',
  executable: '100755',
  symlink: '120000',
  submodule: '160000',
};

export function modeOctal(mode: FileMode): string {
  return OCTAL[mode];
}

/** `48.2 KB`, in the UI language's number format. */
export function formatBytes(bytes: number, locale: Locale): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  const number = new Intl.NumberFormat(locale, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
  return `${number} ${units[unit] ?? 'B'}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Status letter, doubling the color for color-blind users (spec §6.8). */
export const STATUS_LETTER: Record<FileStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typeChanged: 'T',
  untracked: '?',
  conflicted: 'U',
};
