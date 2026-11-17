import { Button } from '@tuuject/koi-react/button';
import { PlusIcon, TrashIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { SecretField } from '@/components/secret-input/secret-field.tsx';
import type { SecretSource } from '@/lib/api/keychain.ts';
import { type HeaderRow, newHeaderRow } from '@/lib/header-rows.ts';

/**
 * Header editing for a custom provider: one row per header, each with the
 * shared secret input (a fresh value under a derived entry name, or an existing
 * entry). Values are write-only — the API returns names only — so a saved row
 * keeps its reference unless the admin submits a new one, and a row can never
 * reveal what is stored.
 */
export function HeaderFields({
  rows,
  onChange,
  valuesRequired,
  nameBase,
  keychainEntries,
  keySources,
}: {
  readonly rows: readonly HeaderRow[];
  readonly onChange: (rows: readonly HeaderRow[]) => void;
  /** `base_url` edits make every saved header value mandatory again. */
  readonly valuesRequired: boolean;
  /** Entry names derive from `<provider>-<header>`; the base is the provider alias. */
  readonly nameBase: string;
  readonly keychainEntries: readonly string[];
  readonly keySources: Readonly<Record<string, SecretSource>>;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <>
      {rows.map((row, index) => (
        <div
          key={`${row.existing ? row.name : `new-${index}`}`}
          className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}
        >
          <HeaderNameInput
            label={t('models.models.headers.header')}
            value={row.name}
            disabled={row.existing}
            invalid={false}
            onChange={(name) => {
              onChange(rows.map((item, at) => (at === index ? { ...item, name } : item)));
            }}
          />
          <SecretField
            label={t('models.models.headers.value')}
            draft={row.draft}
            source={row.existing ? (keySources[row.name] ?? null) : null}
            entries={keychainEntries}
            suggestedName={`${nameBase}-${row.name.trim() || `header-${index + 1}`}`}
            key={`${nameBase}-${row.name}`}
            onChange={(draft) => {
              onChange(rows.map((item, at) => (at === index ? { ...item, draft } : item)));
            }}
            idPrefix={`header-${index}`}
          />
          <div>
            <Button
              size="sm"
              variant="ghost"
              color="error"
              iconStart={<TrashIcon />}
              onClick={() => onChange(rows.filter((_item, at) => at !== index))}
            >
              {t('models.models.headers.remove')}
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant="outline"
          color="secondary"
          iconStart={<PlusIcon />}
          onClick={() => onChange([...rows, newHeaderRow()])}
        >
          {t('models.models.headers.add')}
        </Button>
      </div>
      {valuesRequired &&
      rows.some((row) => row.existing && row.draft.mode === 'new' && row.draft.value.length === 0) ? (
        <p className={css({ marginBlockStart: '2', textStyle: 'small', color: 'warning-text' })}>
          {t('models.models.headers.valuesRequired')}
        </p>
      ) : null}
    </>
  );
}

/** A labelled header name. Saved rows keep their name; renaming is delete + add. */
function HeaderNameInput({
  label,
  value,
  disabled,
  invalid,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const id = useId();
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '1', minWidth: '0' })}>
      <label className={css({ textStyle: 'small', color: 'text-muted' })} htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        invalid={invalid}
        placeholder="x-api-key"
        onChange={(event) => onChange(event.target.value)}
        dir="ltr"
      />
    </div>
  );
}
