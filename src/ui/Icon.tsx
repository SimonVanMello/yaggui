import type { SVGProps } from 'react';

// Minimal stroke icon set (24×24 grid), drawn to match the mockups.
const PATHS = {
  fetch: 'M12 4v11m0 0-4-4m4 4 4-4M5 20h14',
  pull: 'M12 4v12m0 0-5-5m5 5 5-5',
  push: 'M12 20V8m0 0-5 5m5-5 5 5M5 4h14',
  branch:
    'M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 0c0 5-6 4-12 9',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4.9a7.5 7.5 0 0 0-2.2-1.3L14.3 3h-4l-.4 2.3a7.5 7.5 0 0 0-2.2 1.3l-2.4-.9-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-.9a7.5 7.5 0 0 0 2.2 1.3l.4 2.3h4l.4-2.3a7.5 7.5 0 0 0 2.2-1.3l2.4.9 2-3.4-2-1.6c.1-.4.1-.9.1-1.3Z',
  check: 'm5 12 5 5 9-10',
  close: 'M6 6l12 12M18 6 6 18',
  trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3',
  pencil: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Zm9.5-13.5 4 4',
  merge:
    'M18 15a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM6 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm0 6v12m0-12a9 9 0 0 0 9 9',
  chevronDown: 'm6 9 6 6 6-6',
  back: 'M19 12H5m0 0 6-6m-6 6 6 6',
  diffUnified: 'M4 5h16M4 10h16M4 15h16M4 20h10',
  diffSplit: 'M4 4h16v16H4zM12 4v16',
  file: 'M14 3H6v18h12V7l-4-4Zm0 0v4h4',
  image: 'M4 4h16v16H4zm0 12 5-5 4 4 2-2 5 5M15 9h.01',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  tree: 'M4 4h6M7 4v14h5m-5-7h5m3-7h5m-5 7h5m-5 7h5',
  chevronUp: 'm6 15 6-6 6 6',
  chevronRight: 'm9 6 6 6-6 6',
  info: 'M12 8h.01M11 12h1v5h1M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  warning:
    'M12 9v4m0 4h.01M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  error: 'M12 8v5m0 3.5h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  search: 'm20 20-4.3-4.3M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  folderOpen:
    'M3 17V7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1M3 17l2.6-6.1A1.5 1.5 0 0 1 7 10h13.2a1 1 0 0 1 .9 1.4L18.5 18a1.5 1.5 0 0 1-1.4 1H5a2 2 0 0 1-2-2Z',
  star: 'm12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z',
  clone:
    'M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z',
  init: 'M12 3v4m0 10v4M3 12h4m10 0h4M5.6 5.6l2.8 2.8m7.2 7.2 2.8 2.8m0-12.8-2.8 2.8m-7.2 7.2-2.8 2.8',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'm15 14 5-5-5-5m5 5H9a5 5 0 0 0 0 10h3',
  stash: 'M4 7h16v4H4zM5 11v8h14v-8M10 15h4',
  pop: 'M4 13h16v6H4zM12 3v7m0-7-3 3m3-3 3 3',
  terminal: 'm5 8 4 4-4 4m6 0h8M3 4h18v16H3z',
  cloud: 'M7 18a4 4 0 0 1-.6-8 6 6 0 0 1 11.5 1.5A3.5 3.5 0 0 1 17.5 18H7Z',
  laptop: 'M5 6h14v9H5zM3 18h18',
  tag: 'M3 12V4h8l9 9-8 8-9-9Zm5-4h.01',
  commit: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 12h6m6 0h6',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  panelLeft: 'M4 5h16v14H4zM9 5v14',
  panelRight: 'M4 5h16v14H4zM15 5v14',
  panelBottom: 'M4 5h16v14H4zM4 14h16',
  log: 'M4 6h16M4 12h16M4 18h10',
  windowMinimize: 'M5 12h14',
  windowMaximize: 'M6 6h12v12H6z',
  windowRestore: 'M6 9h9v9H6zM9 9V6h9v9h-3',
  windowClose: 'M6 6l12 12M18 6 6 18',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  retry: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  box: 'm12 3 8 4v10l-8 4-8-4V7l8-4Zm0 8 8-4m-8 4v10m0-10L4 7',
  history: 'M3 12a9 9 0 1 0 2.6-6.4M3 4v4h4M12 7v5l3 2',
  blame: 'M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h6',
  drop: 'M12 4v10m0 0-4-4m4 4 4-4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeOff:
    'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  solo: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-4h.01',
  compare: 'M7 4 3 8l4 4M3 8h14m0 4 4 4-4 4m4-4H7',
  external: 'M14 4h6v6m0-6-9 9m7 1v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  name: IconName;
  size?: 'sm' | 'md' | 'lg';
  /** Fills the shape with the current color (e.g. an active star). */
  filled?: boolean;
}

export function Icon({ name, size = 'sm', filled = false, className, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{
        width: `var(--icon-size-${size})`,
        height: `var(--icon-size-${size})`,
        flex: 'none',
      }}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
