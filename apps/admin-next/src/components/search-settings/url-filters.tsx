import { Field } from '@tuuject/koi-react/field';
import { css, cx } from '@tuuject/koi-react/styled-system/css';
import { Textarea } from '@tuuject/koi-react/textarea';
import { RE2JS } from 're2js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel } from '@/components/layout/panel';
import { splitLines } from './draft.ts';

/**
 * URL rules plus a preview. The preview compiles the same expressions the
 * server will store, with the same RE2 engine, and marks each pasted URL as
 * dropped or kept; it never sends a search, so trying a rule costs nothing.
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
      return { rule, pattern: RE2JS.compile(rule) };
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
    <Panel title={t('search.filtersTitle')} description={t('search.filtersDescription')}>
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
        <Field
          label={t('search.filtersLabel')}
          help={t('search.filtersHint')}
          error={
            compiled.some((entry) => entry.pattern === null)
              ? t('search.filtersInvalid', {
                  rules: compiled
                    .filter((entry) => entry.pattern === null)
                    .map((entry) => entry.rule)
                    .join(', '),
                })
              : undefined
          }
        >
          <Textarea
            rows={4}
            value={rules}
            onChange={(event) => onRulesChange(event.target.value)}
            placeholder={'csdn\nspam\\.example'}
            disabled={disabled}
            className={css({ fontFamily: 'mono' })}
          />
        </Field>
        <Field label={t('search.filterTestLabel')} help={t('search.filterTestHint')}>
          <Textarea
            rows={3}
            value={testText}
            onChange={(event) => setTestText(event.target.value)}
            placeholder={'https://blog.csdn.net/article/1\nhttps://example.com/page'}
          />
        </Field>
        {results.length > 0 ? (
          <ul
            className={css({ textStyle: 'body', '& > :not(:last-child)': { marginBlockEnd: '1' } })}
            aria-live="polite"
          >
            {results.map((result) => (
              <li
                key={result.url}
                className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}
              >
                <span
                  className={cx(
                    css({ wordBreak: 'break-all' }),
                    result.matchedBy.length > 0 &&
                      css({ bg: 'error-surface', color: 'error-text', textDecorationLine: 'line-through' }),
                  )}
                >
                  {result.url}
                </span>
                <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                  {result.matchedBy.length > 0
                    ? t('search.filterMatched', { rules: result.matchedBy.join(', ') })
                    : t('search.filterKept')}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}
