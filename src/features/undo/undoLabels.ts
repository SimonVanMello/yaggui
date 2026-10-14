import type { MessageKey, MessageParams } from '../../i18n/i18n';
import type { JournalOp, UndoBlock } from '../../ipc';

const SUMMARY_MAX = 60;
const SHA_LENGTH = 7;

export interface Message {
  key: MessageKey;
  params?: MessageParams;
}

function clip(text: string): string {
  const line = text.split('\n', 1)[0]?.trim() ?? '';
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** What a journaled operation is, as a short phrase ("commit "fix: …""). */
export function opMessage(op: JournalOp): Message {
  switch (op.kind) {
    case 'commit':
      return { key: 'undo.op.commit', params: { summary: clip(op.summary) } };
    case 'amend':
      return { key: 'undo.op.amend', params: { summary: clip(op.summary) } };
    case 'checkout':
      return op.branch === null
        ? { key: 'undo.op.checkout.detached', params: { sha: op.sha.slice(0, SHA_LENGTH) } }
        : { key: 'undo.op.checkout', params: { branch: op.branch } };
    case 'createBranch':
      return { key: 'undo.op.createBranch', params: { name: op.name } };
    case 'deleteBranch':
      return {
        key: op.remote ? 'undo.op.deleteBranch.remote' : 'undo.op.deleteBranch',
        params: { name: op.name },
      };
    case 'renameBranch':
      return { key: 'undo.op.renameBranch', params: { from: op.from, to: op.to } };
    case 'createTag':
      return { key: 'undo.op.createTag', params: { name: op.name } };
    case 'deleteTag':
      return { key: 'undo.op.deleteTag', params: { name: op.name } };
    case 'addRemote':
      return { key: 'undo.op.addRemote', params: { name: op.name } };
    case 'renameRemote':
      return { key: 'undo.op.renameRemote', params: { from: op.from, to: op.to } };
    case 'setRemoteUrls':
      return { key: 'undo.op.setRemoteUrls', params: { name: op.name } };
    case 'removeRemote':
      return { key: 'undo.op.removeRemote', params: { name: op.name } };
    case 'merge':
      return { key: 'undo.op.merge', params: { source: op.source } };
    case 'reset':
      return { key: 'undo.op.reset', params: { mode: op.mode, target: clip(op.target) } };
    case 'discard': {
      const [first] = op.paths;
      return op.count === 1 && first !== undefined
        ? { key: 'undo.op.discard.file', params: { path: first } }
        : { key: 'undo.op.discard', params: { count: op.count } };
    }
    case 'stashDrop':
      return { key: 'undo.op.stashDrop', params: { message: clip(op.message) } };
    case 'cherryPick':
      return { key: 'undo.op.cherryPick', params: { count: op.count } };
    case 'revert':
      return { key: 'undo.op.revert', params: { sha: op.sha.slice(0, SHA_LENGTH) } };
    case 'push':
      return {
        key: op.delete ? 'undo.op.push.delete' : 'undo.op.push',
        params: { name: op.name ?? op.remote ?? '' },
      };
    case 'pushTags':
      return { key: 'undo.op.pushTags', params: { remote: op.remote } };
    case 'fetch':
      return { key: 'undo.op.fetch', params: { remote: op.remote ?? '' } };
    case 'pull':
      return { key: 'undo.op.pull' };
    case 'createWorktree':
      return { key: 'undo.op.createWorktree', params: { name: baseName(op.path) } };
    case 'removeWorktree':
      return { key: 'undo.op.removeWorktree', params: { name: baseName(op.path) } };
    case 'lfsTrack':
      return { key: 'undo.op.lfsTrack', params: { pattern: op.pattern } };
    case 'lfsPull':
      return { key: 'undo.op.lfsPull' };
    case 'updateSubmodules':
      return { key: 'undo.op.updateSubmodules' };
    case 'stashPush': {
      const [first] = op.paths;
      return op.count === 1 && first !== undefined
        ? { key: 'undo.op.stashPush.file', params: { path: first } }
        : { key: 'undo.op.stashPush', params: { count: op.count } };
    }
    case 'gitignore':
      return { key: 'undo.op.gitignore', params: { rule: op.rule } };
    case 'deleteBranches': {
      const [first] = op.names;
      return op.count === 1 && first !== undefined
        ? { key: 'undo.op.deleteBranch', params: { name: first } }
        : { key: 'undo.op.deleteBranches', params: { count: op.count } };
    }
  }
}

/** Why an operation cannot be undone or redone, for the button tooltip and the history. */
export function blockMessage(block: UndoBlock): Message {
  switch (block.kind) {
    case 'published':
      return { key: 'undo.blocked.published' };
    case 'pruned':
      return { key: 'undo.blocked.pruned' };
    case 'pulled':
      return { key: 'undo.blocked.pulled' };
    case 'notRecorded':
      return { key: 'undo.blocked.notRecorded' };
    case 'downloaded':
      return { key: 'undo.blocked.downloaded' };
    case 'filesDeleted':
      return { key: 'undo.blocked.filesDeleted' };
    case 'diverged':
      return { key: 'undo.blocked.diverged', params: { refs: refList(block.refs) } };
  }
}

/** `refs/heads/main` → `main`, `refs/tags/v1` → `v1`; `HEAD` stays. */
export function shortRef(ref: string): string {
  for (const prefix of ['refs/heads/', 'refs/tags/', 'refs/remotes/']) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return ref;
}

export function refList(refs: readonly string[]): string {
  return refs.map(shortRef).join(', ');
}
