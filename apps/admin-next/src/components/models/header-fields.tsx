import { Input } from '@tuuject/koi-react/input';
import { MapEditor } from '@tuuject/koi-react/map-editor';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { HeaderRow } from '@/lib/header-rows.ts';

/**
 * The MapEditor entry shapes. `saved` travels with both halves so the key field
 * can stay disabled and the value field can keep its "empty means keep" hint.
 */
interface HeaderKey {
  readonly name: string;
  readonly saved: boolean;
}

interface HeaderValue {
  readonly text: string;
  readonly saved: boolean;
}

/**
 * Header editing for a custom provider, built on Koi's MapEditor. Values are
 * write-only — the API returns names only — so a saved header keeps its value
 * unless the admin types a new one, and a row can never reveal what is stored.
 */
export function HeaderFields({
  rows,
  onChange,
  valuesRequired,
}: {
  readonly rows: readonly HeaderRow[];
  readonly onChange: (rows: readonly HeaderRow[]) => void;
  /** `base_url` edits make every saved header value mandatory again. */
  readonly valuesRequired: boolean;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <>
      <MapEditor<HeaderKey, HeaderValue>
        sortable={false}
        value={rows.map((row) => ({
          key: { name: row.name, saved: row.existing },
          value: { text: row.value, saved: row.existing },
        }))}
        onChange={(entries) => {
          onChange(
            entries.map((entry) => ({
              name: entry.key.name,
              value: entry.value.text,
              existing: entry.key.saved,
            })),
          );
        }}
        createEntry={() => ({
          key: { name: '', saved: false },
          value: { text: '', saved: false },
        })}
        keyEquals={(left, right) => left.name.trim() === right.name.trim()}
        valueEquals={(left, right) => left.text === right.text && left.saved === right.saved}
        // The row labels make each row taller than one control. Keep the arrow
        // and remove button on the control line: align to the top with the
        // label height + gap, so an inline error under the key cannot drag
        // them down. MapEditor does not forward `classNames.arrow`, so target
        // the arrow from the fields slot: the only direct span in the map grid.
        classNames={{
          fields: css({ '& > span': { marginBlockStart: '5' } }),
          remove: css({ marginBlockStart: '5' }),
        }}
        renderKey={({ value, onChange: changeKey, disabled, invalid }) => (
          <HeaderNameInput
            label={t('models.models.headers.header')}
            value={value.name}
            disabled={disabled === true || value.saved}
            invalid={invalid === true}
            onChange={(name) => changeKey({ ...value, name })}
          />
        )}
        renderValue={({ value, onChange: changeValue, disabled }) => (
          <HeaderValueInput
            label={t('models.models.headers.value')}
            value={value.text}
            disabled={disabled === true}
            placeholder={value.saved ? t('models.models.headers.keepPlaceholder') : ''}
            onChange={(text) => changeValue({ ...value, text })}
          />
        )}
        addLabel={t('models.models.headers.add')}
      />
      {valuesRequired && rows.some((row) => row.existing && row.value.length === 0) ? (
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
      />
    </div>
  );
}

/** A write-only header value; saved rows show the keep placeholder. */
function HeaderValueInput({
  label,
  value,
  disabled,
  placeholder,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly placeholder: string;
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
        type="password"
        autoComplete="new-password"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
