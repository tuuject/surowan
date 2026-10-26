import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { splitLines } from './draft.ts';

/**
 * URL rules plus a preview. The preview compiles the same expressions the
 * server will store and marks each pasted URL as dropped or kept; it never
 * sends a search, so trying a rule costs nothing.
 */
export function UrlFilterEditor({
  rules,
  onRulesChange,
  disabled,
}: {
  readonly rules: string;
  readonly onRulesChange: (value: string) => void;
  readonly disabled: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const [testText, setTestText] = useState('');
  const compiled = splitLines(rules).map((rule) => {
    try {
      return { rule, pattern: new RegExp(rule) };
    } catch {
      return { rule, pattern: null };
    }
  });
  // A pasted URL may repeat; the preview reports each distinct line once, which
  // also keeps the list keyed by the URL itself instead of its position.
  const results = [...new Set(splitLines(testText))].map((url) => ({
    url,
    matchedBy: compiled.filter((entry) => entry.pattern?.test(url) === true).map((entry) => entry.rule),
  }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('search.filtersTitle')}</CardTitle>
        <p className="text-muted-foreground text-sm">{t('search.filtersDescription')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="search-url-filters">{t('search.filtersLabel')}</Label>
          <Textarea
            id="search-url-filters"
            rows={4}
            value={rules}
            onChange={(event) => onRulesChange(event.target.value)}
            placeholder={'csdn\nspam\\.example'}
            disabled={disabled}
          />
          <p className="text-muted-foreground text-xs">{t('search.filtersHint')}</p>
          {compiled.some((entry) => entry.pattern === null) ? (
            <p role="alert" className="text-destructive text-xs">
              {t('search.filtersInvalid', {
                rules: compiled
                  .filter((entry) => entry.pattern === null)
                  .map((entry) => entry.rule)
                  .join(', '),
              })}
            </p>
          ) : null}
        </div>
        <div className="space-y-1">
          <Label htmlFor="search-url-filter-test">{t('search.filterTestLabel')}</Label>
          <Textarea
            id="search-url-filter-test"
            rows={3}
            value={testText}
            onChange={(event) => setTestText(event.target.value)}
            placeholder={'https://blog.csdn.net/article/1\nhttps://example.com/page'}
          />
          <p className="text-muted-foreground text-xs">{t('search.filterTestHint')}</p>
        </div>
        {results.length > 0 ? (
          <ul className="space-y-1 text-sm" aria-live="polite">
            {results.map((result) => (
              <li key={result.url} className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'break-all',
                    result.matchedBy.length > 0 && 'bg-destructive/15 text-destructive line-through',
                  )}
                >
                  {result.url}
                </span>
                <span className="text-muted-foreground text-xs">
                  {result.matchedBy.length > 0
                    ? t('search.filterMatched', { rules: result.matchedBy.join(', ') })
                    : t('search.filterKept')}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
