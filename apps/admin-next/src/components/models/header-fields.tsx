import { Button, IconButton } from '@tuuject/koi-react/button';
import { PlusIcon, TrashIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useTranslation } from 'react-i18next';
import { type HeaderRow, newRowId } from '@/lib/header-rows.ts';

/**
 * Header editing for a custom provider. Values are write-only — the API returns
 * names only — so a saved header keeps its value unless the admin types a new
 * one, and a row can never reveal what is stored.
 */
export function HeaderFields({
  rows,
  onChange,
  valuesRequired,
  idPrefix,
}: {
  readonly rows: readonly HeaderRow[];
  readonly onChange: (rows: readonly HeaderRow[]) => void;
  /** `base_url` edits make every saved header value mandatory again. */
  readonly valuesRequired: boolean;
  readonly idPrefix: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const update = (index: number, patch: Partial<HeaderRow>): void => {
    onChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
      {rows.map((row, index) => (
        <div key={row.id} className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '2' })}>
          <div className={css({ minWidth: '160px', flex: '1 1 0%', '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <label
              className={css({ textStyle: 'small', color: 'text-muted' })}
              htmlFor={`${idPrefix}-header-name-${String(index)}`}
            >
              {t('models.models.headers.header')}
            </label>
            <Input
              id={`${idPrefix}-header-name-${String(index)}`}
              value={row.name}
              disabled={row.existing}
              placeholder="x-api-key"
              onChange={(event) => update(index, { name: event.target.value })}
            />
          </div>
          <div className={css({ minWidth: '192px', flex: '1 1 0%', '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <label
              className={css({ textStyle: 'small', color: 'text-muted' })}
              htmlFor={`${idPrefix}-header-value-${String(index)}`}
            >
              {t('models.models.headers.value')}
            </label>
            <Input
              id={`${idPrefix}-header-value-${String(index)}`}
              type="password"
              autoComplete="new-password"
              value={row.value}
              placeholder={row.existing ? t('models.models.headers.keepPlaceholder') : ''}
              onChange={(event) => update(index, { value: event.target.value })}
            />
          </div>
          <IconButton
            variant="outline"
            onClick={() => onChange(rows.filter((_, position) => position !== index))}
            label={
              row.existing
                ? t('models.models.headers.deleteAria', { name: row.name })
                : t('models.models.headers.removeAria')
            }
            icon={<TrashIcon />}
          />
        </div>
      ))}
      {valuesRequired && rows.some((row) => row.existing && row.value.length === 0) ? (
        <p className={css({ textStyle: 'small', color: 'warning-text' })}>
          {t('models.models.headers.valuesRequired')}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        color="secondary"
        size="sm"
        onClick={() => onChange([...rows, { id: newRowId(), name: '', value: '', existing: false }])}
        iconStart={<PlusIcon className={css({ width: 'icon', height: 'icon' })} />}
      >
        {t('models.models.headers.add')}
      </Button>
    </div>
  );
}
