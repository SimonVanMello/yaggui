import { useId, useState } from 'react';

import { localize } from '../../app/errors/presentError';
import { usePreferences } from '../../app/usePreferences';
import { useShellStore } from '../../app/shellStore';
import { useT } from '../../i18n/useT';
import {
  YagguiIpcError,
  ipc,
  unwrap,
  type ExternalToolCheck,
  type ExternalToolKind,
  type YagguiError,
  type TerminalMode,
} from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { TextInput } from '../../ui/TextInput';
import { activeRepoId } from '../repo/repoSessions';
import { Row } from './Row';
import { savePreferenceOrToast } from './savePreference';
import styles from './ToolsTab.module.css';

/** Tools `git difftool` / `git mergetool` know; any other name is a custom tool. */
const GIT_TOOLS = [
  'meld',
  'kdiff3',
  'vimdiff',
  'bc',
  'opendiff',
  'p4merge',
  'smerge',
  'araxis',
  'winmerge',
  'tortoisemerge',
  'xxdiff',
];

type TestState =
  | { kind: 'running' }
  | { kind: 'done'; check: ExternalToolCheck }
  | { kind: 'failed'; error: YagguiError };

/**
 * External editor, terminal, diff and merge tools (F-323), each with a launch test, and the
 * choice between the integrated terminal (F-267) and the external one.
 */
export function ToolsTab() {
  const t = useT();
  const prefs = usePreferences();
  return (
    <>
      <ToolRow
        kind="editor"
        label={t('tools.editor')}
        hint={t('tools.editor.hint')}
        placeholder={t('tools.editor.placeholder')}
        value={prefs.editor}
        field="editor"
      />
      <Row
        label={t('prefs.terminalMode')}
        hint={t(
          prefs.terminalMode === 'integrated'
            ? 'prefs.terminalMode.integratedHint'
            : 'prefs.terminalMode.externalHint',
        )}
      >
        <SegmentedControl<TerminalMode>
          label={t('prefs.terminalMode')}
          value={prefs.terminalMode}
          options={[
            { value: 'integrated', label: t('prefs.terminalMode.integrated') },
            { value: 'external', label: t('prefs.terminalMode.external') },
          ]}
          onChange={(terminalMode) => {
            savePreferenceOrToast({ terminalMode });
          }}
        />
      </Row>
      <Row
        label={t('prefs.terminal.external')}
        hint={
          prefs.terminal
            ? t('prefs.terminal.current', { name: prefs.terminal })
            : t('prefs.terminal.default')
        }
      >
        <Button
          onClick={() => {
            useShellStore.getState().setTerminalDialogOpen(true);
          }}
        >
          {t('prefs.terminal.configure')}
        </Button>
        <TestButton kind="terminal" name={prefs.terminal} />
      </Row>
      <ToolRow
        kind="diffTool"
        label={t('tools.diff')}
        hint={t('tools.diff.hint')}
        placeholder={t('tools.tool.placeholder')}
        value={prefs.diffTool}
        field="diffTool"
        suggestions={GIT_TOOLS}
      />
      <ToolRow
        kind="mergeTool"
        label={t('tools.merge')}
        hint={t('tools.merge.hint')}
        placeholder={t('tools.tool.placeholder')}
        value={prefs.mergeTool}
        field="mergeTool"
        suggestions={GIT_TOOLS}
      />
    </>
  );
}

interface ToolRowProps {
  kind: ExternalToolKind;
  label: string;
  hint: string;
  placeholder: string;
  value: string | null;
  field: 'editor' | 'diffTool' | 'mergeTool';
  suggestions?: readonly string[];
}

function ToolRow({ kind, label, hint, placeholder, value, field, suggestions }: ToolRowProps) {
  const id = useId();
  const listId = useId();
  const [draft, setDraft] = useState(value ?? '');
  const commit = () => {
    const next = draft.trim() || null;
    if (next !== value) savePreferenceOrToast({ [field]: next });
  };
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <TextInput
        id={id}
        mono
        value={draft}
        placeholder={placeholder}
        list={suggestions ? listId : undefined}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
      />
      {suggestions && (
        <datalist id={listId}>
          {suggestions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
      <TestButton kind={kind} name={draft.trim() || null} />
    </Row>
  );
}

/** Runs the check on the value being edited, and says what happened under the row. */
function TestButton({ kind, name }: { kind: ExternalToolKind; name: string | null }) {
  const t = useT();
  const [state, setState] = useState<TestState | null>(null);
  const test = async () => {
    setState({ kind: 'running' });
    try {
      const check = await unwrap(ipc.commands.checkExternalTool(kind, name, activeRepoId()));
      setState({ kind: 'done', check });
    } catch (failure) {
      if (failure instanceof YagguiIpcError) setState({ kind: 'failed', error: failure.error });
      else throw failure;
    }
  };
  return (
    <>
      <Button
        disabled={state?.kind === 'running'}
        onClick={() => {
          void test();
        }}
      >
        {t('tools.test')}
      </Button>
      <span className={styles.result} role="status" data-kind={state?.kind}>
        {state?.kind === 'done' && state.check.ok && (
          <>
            <Icon name="check" className={styles.ok} />
            {kind === 'editor' || kind === 'terminal'
              ? t('tools.test.launched', { tool: state.check.tool })
              : t('tools.test.available', { tool: state.check.tool })}
          </>
        )}
        {state?.kind === 'done' && !state.check.ok && (
          <>
            <Icon name="warning" className={styles.warn} />
            {state.check.issue === 'notConfigured'
              ? t(kind === 'diffTool' ? 'tools.test.noDiff' : 'tools.test.noMerge')
              : state.check.issue === 'notInstalled'
                ? t('tools.test.notInstalled', { tool: state.check.tool })
                : t('tools.test.unknown', { tool: state.check.tool })}
          </>
        )}
        {state?.kind === 'failed' && (
          <>
            <Icon name="error" className={styles.error} />
            {localize(state.error.message)}
          </>
        )}
      </span>
    </>
  );
}
