import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { DictionaryConflict } from '@/lib/api/dictionary.ts';

export interface DictionaryConflictAlertProps {
  readonly conflicts: readonly DictionaryConflict[];
  readonly onSelectEntries: (entryIds: readonly string[]) => void;
}

/** Duplicate Term/Alias report; each conflict can be selected for merging. */
export function DictionaryConflictAlert({ conflicts, onSelectEntries }: DictionaryConflictAlertProps): ReactElement {
  const { t } = useTranslation();

  return (
    <Alert tone="warning" title={t('dictionary.conflicts.title')}>
      <p>{t('dictionary.conflicts.description')}</p>
      <ul className={css({ marginBlockStart: '2', '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
        {conflicts.map((conflict) => (
          <li
            key={conflict.value}
            className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}
          >
            <span className={css({ textStyle: 'small', fontFamily: 'mono' })}>{conflict.value}</span>
            <span className={css({ textStyle: 'small', color: 'text-muted' })}>
              {t('dictionary.conflicts.entries', { count: conflict.entry_ids.length })}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              color="secondary"
              onClick={() => onSelectEntries(conflict.entry_ids)}
            >
              {t('dictionary.conflicts.mergeThis')}
            </Button>
          </li>
        ))}
      </ul>
    </Alert>
  );
}
