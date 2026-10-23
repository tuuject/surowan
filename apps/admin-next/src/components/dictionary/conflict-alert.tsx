import { AlertTriangle } from 'lucide-react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { DictionaryConflict } from '@/lib/api/dictionary.ts';

export interface DictionaryConflictAlertProps {
  readonly conflicts: readonly DictionaryConflict[];
  readonly onSelectEntries: (entryIds: readonly string[]) => void;
}

/** Duplicate Term/Alias report; each conflict can be selected for merging. */
export function DictionaryConflictAlert({
  conflicts,
  onSelectEntries,
}: DictionaryConflictAlertProps): React.ReactElement {
  const { t } = useTranslation();

  return (
    <Alert>
      <AlertTriangle className="text-warning" />
      <AlertTitle>{t('dictionary.conflicts.title')}</AlertTitle>
      <AlertDescription>
        <p>{t('dictionary.conflicts.description')}</p>
        <ul className="mt-2 space-y-1">
          {conflicts.map((conflict) => (
            <li key={conflict.value} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{conflict.value}</span>
              <span className="text-muted-foreground text-xs">
                {t('dictionary.conflicts.entries', { count: conflict.entry_ids.length })}
              </span>
              <Button type="button" size="xs" variant="outline" onClick={() => onSelectEntries(conflict.entry_ids)}>
                {t('dictionary.conflicts.mergeThis')}
              </Button>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
