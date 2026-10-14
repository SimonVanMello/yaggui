import { execShellAction } from '../../app/shellActions';
import { platform } from '../../ui/platform';
import { registerBinding } from './registry';

const TAB_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/**
 * Shortcut-only commands, next to the palette actions: the palette itself, "go to tab n", and
 * the ones owned by a context (the tab strip, the graph), which read their shortcut with
 * `matchBinding`.
 */
export function registerBuiltinBindings(): () => void {
  const off = [
    registerBinding({
      id: 'app.palette',
      title: 'keybindings.action.palette',
      group: 'app',
      defaultShortcut: 'Mod+K',
      run: () => {
        execShellAction('commandPalette');
      },
    }),
    // Ctrl+Y is the usual redo on Windows and Linux; on macOS it is not a redo.
    ...(platform === 'mac'
      ? []
      : [
          registerBinding({
            id: 'edit.redoAlt',
            title: 'keybindings.action.redoAlt',
            group: 'git',
            defaultShortcut: 'Ctrl+Y',
            run: () => {
              execShellAction('redo');
            },
          }),
        ]),
    ...TAB_NUMBERS.map((n) =>
      registerBinding({
        id: `tab.goto.${String(n)}`,
        title: 'keybindings.action.tabGoto',
        titleParams: { n },
        group: 'tabs',
        defaultShortcut: `Mod+${String(n)}`,
        run: () => {
          execShellAction(`tab${String(n)}` as `tab${(typeof TAB_NUMBERS)[number]}`);
        },
      }),
    ),
    registerBinding({
      id: 'tab.moveLeft',
      title: 'keybindings.action.tabMoveLeft',
      group: 'tabs',
      defaultShortcut: 'Mod+Shift+ArrowLeft',
    }),
    registerBinding({
      id: 'tab.moveRight',
      title: 'keybindings.action.tabMoveRight',
      group: 'tabs',
      defaultShortcut: 'Mod+Shift+ArrowRight',
    }),
    registerBinding({
      id: 'graph.search',
      title: 'keybindings.action.graphSearch',
      group: 'graph',
      defaultShortcut: 'Mod+F',
    }),
    registerBinding({
      id: 'graph.goToHead',
      title: 'keybindings.action.graphGoToHead',
      group: 'graph',
      defaultShortcut: 'Mod+Shift+H',
    }),
    registerBinding({
      id: 'graph.copySha',
      title: 'keybindings.action.graphCopySha',
      group: 'graph',
      defaultShortcut: 'Mod+C',
    }),
    registerBinding({
      id: 'graph.copyMessage',
      title: 'keybindings.action.graphCopyMessage',
      group: 'graph',
      defaultShortcut: 'Mod+Shift+C',
    }),
  ];
  return () => {
    for (const unregister of off) unregister();
  };
}
