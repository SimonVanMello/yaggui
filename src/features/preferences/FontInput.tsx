import { useT } from '../../i18n/useT';
import { TextInput } from '../../ui/TextInput';
import { useDraft } from './useDraft';

interface FontInputProps {
  id: string;
  value: string | null;
  mono?: boolean;
  onCommit: (value: string | null) => void;
}

/** Saved on Enter or when leaving the field, not on every keystroke. */
export function FontInput({ id, value, mono, onCommit }: FontInputProps) {
  const t = useT();
  const [draft, setDraft] = useDraft(value ?? '');
  const commit = () => {
    const next = draft.trim() || null;
    if (next !== value) onCommit(next);
  };
  return (
    <TextInput
      id={id}
      mono={mono}
      value={draft}
      placeholder={t('prefs.font.placeholder')}
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
  );
}
