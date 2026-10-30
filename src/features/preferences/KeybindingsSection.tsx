import { useMemo } from 'react';

import { translate } from '../../i18n/i18n';
import { KeybindingsTab } from '../keybindings/KeybindingsTab';
import { listBindings } from '../keybindings/registry';
import { namesMatch } from './settingsIndex';
import { Setting } from './Setting';
import { useSettingsFilter } from './settingsFilter';

/** Titles of every command, in both languages, for the search of the dialog. */
export function commandTitles(): string[] {
  return listBindings().flatMap((binding) =>
    (['en', 'fr'] as const).map((locale) => translate(locale, binding.title, binding.titleParams)),
  );
}

/** The shortcut editor; a search that names commands opens it filtered on them. */
export function KeybindingsSection() {
  const { query } = useSettingsFilter();
  const titles = useMemo(() => commandTitles(), []);
  const initial = namesMatch(query, titles) ? query : '';
  return (
    <Setting id="keybindings">
      <KeybindingsTab key={initial} initialFilter={initial} />
    </Setting>
  );
}
