import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { SecretSource } from '@/lib/api/keychain.ts';
import { type SecretDraft, secretNameInvalid } from '@/lib/secret-draft.ts';

export type { SecretDraft } from '@/lib/secret-draft.ts';
export { initialSecretDraft, secretNameInvalid, secretValueOf } from '@/lib/secret-draft.ts';

/**
 * The one control every secret-accepting settings field shares: enter a new
 * key (its entry name is editable and prefilled from where the field sits),
 * or pick an existing keychain entry. A field whose secret comes from an
 * environment variable or an external command starts as read-only — the panel
 * cannot create such references — and the same control switches it to a
 * keychain entry.
 *
 * The draft lives with the page (the save payload is built there through
 * `secretValueOf` in `lib/secret-draft.ts`), so this component stays a
 * controlled view. The value input carries `idPrefix` verbatim; the auxiliary
 * controls derive theirs.
 */
type ModeChoice = 'new' | 'entry' | 'external';

export function SecretField({
  label,
  draft,
  source,
  entries,
  suggestedName,
  disabled,
  onChange,
  idPrefix,
}: {
  readonly label: string;
  readonly draft: SecretDraft;
  /** Where the secret currently comes from; drives the read-only external state. */
  readonly source: SecretSource;
  /** Entry names the panel may pick from; empty hides the reuse choice. */
  readonly entries: readonly string[];
  readonly suggestedName: string;
  readonly disabled?: boolean;
  readonly onChange: (draft: SecretDraft) => void;
  readonly idPrefix: string;
}): ReactElement {
  const { t } = useTranslation();
  const externalSource = source?.kind === 'env' || source?.kind === 'command' ? source : null;
  const choices: readonly ModeChoice[] = [
    'new',
    ...(entries.length > 0 ? (['entry'] as const) : []),
    ...(externalSource !== null ? (['external'] as const) : []),
  ];
  const mode: ModeChoice = choices.includes(draft.mode) ? draft.mode : (choices[0] ?? 'new');
  const showChoice = choices.length > 1;
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
      {showChoice ? (
        <Field
          label={t('common.secret.sourceLabel')}
          help={
            externalSource === null
              ? undefined
              : externalSource.kind === 'env'
                ? t('common.secret.providedByEnv', { env: externalSource.env })
                : t('common.secret.providedByCommand')
          }
        >
          <Select
            id={`${idPrefix}-source`}
            value={mode}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value as ModeChoice;
              onChange(
                next === 'new'
                  ? { mode: 'new', value: '', name: suggestedName }
                  : next === 'entry'
                    ? { mode: 'entry', entry: entries[0] ?? '' }
                    : { mode: 'external' },
              );
            }}
          >
            <option value="new">{t('common.secret.newKey')}</option>
            {entries.length > 0 ? <option value="entry">{t('common.secret.existingEntry')}</option> : null}
            {externalSource !== null ? <option value="external">{t('common.secret.external')}</option> : null}
          </Select>
        </Field>
      ) : null}
      {mode === 'new' ? (
        <>
          <Field label={label} help={t('common.secret.valueHint')}>
            <Input
              id={idPrefix}
              type="password"
              autoComplete="new-password"
              placeholder={t('common.secret.valuePlaceholder')}
              value={draft.mode === 'new' ? draft.value : ''}
              onChange={(event) =>
                onChange({
                  mode: 'new',
                  value: event.target.value,
                  name: draft.mode === 'new' ? draft.name : suggestedName,
                })
              }
              disabled={disabled}
              dir="ltr"
            />
          </Field>
          <Field label={t('common.secret.entryName')} help={t('common.secret.nameHint')}>
            <Input
              id={`${idPrefix}-name`}
              // An untouched draft shows the derived name: editing it makes the
              // choice explicit, leaving it alone keeps the derivation.
              value={draft.mode === 'new' ? draft.name || suggestedName : suggestedName}
              onChange={(event) =>
                onChange({ mode: 'new', value: draft.mode === 'new' ? draft.value : '', name: event.target.value })
              }
              disabled={disabled}
              dir="ltr"
            />
          </Field>
          {secretNameInvalid(draft) ? (
            <p role="alert" className={css({ textStyle: 'small', color: 'error-text' })}>
              {t('common.secret.nameInvalid')}
            </p>
          ) : null}
        </>
      ) : null}
      {mode === 'entry' ? (
        <Field label={label} help={t('common.secret.existingHint')}>
          <Select
            id={`${idPrefix}-entry`}
            value={draft.mode === 'entry' ? draft.entry : (entries[0] ?? '')}
            disabled={disabled}
            onChange={(event) => onChange({ mode: 'entry', entry: event.target.value })}
          >
            {entries.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {mode === 'external' && externalSource !== null ? (
        <p className={css({ textStyle: 'small', color: 'text-muted' })} id={`${idPrefix}-external`}>
          {externalSource.kind === 'env'
            ? t('common.secret.providedByEnv', { env: externalSource.env })
            : t('common.secret.providedByCommand')}
        </p>
      ) : null}
    </div>
  );
}
