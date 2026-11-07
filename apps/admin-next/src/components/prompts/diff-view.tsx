import { css, cx } from '@tuuject/koi-react/styled-system/css';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import type { PromptDiffHunk, PromptDiffLine, PromptDiffView } from '@/lib/api/prompts.ts';

function diffMarker(type: PromptDiffLine['type']): string {
  return type === 'added' ? '+' : type === 'removed' ? '-' : ' ';
}

/** Hunk separator in the unified-diff header format the API emits. */
function hunkHeader(hunk: PromptDiffHunk): string {
  return `@@ -${hunk.fromStart},${hunk.fromCount} +${hunk.toStart},${hunk.toCount} @@`;
}

export function DiffView({ diff }: { readonly diff: PromptDiffView }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className={css({ overflowX: 'auto', borderBlockWidth: '1px', borderColor: 'divider' })}>
      <div
        className={css({
          textStyle: 'small',
          bg: 'surface-muted',
          borderBottomWidth: '1px',
          borderColor: 'divider',
          paddingInline: '3',
          paddingBlock: '2',
          fontFamily: 'mono',
        })}
      >
        {t('pages.prompts.diffTitle', { from: diff.from.seq, to: diff.to.seq })}
      </div>
      <div className={css({ maxHeight: '32rem', overflow: 'auto' })}>
        <pre className={css({ textStyle: 'small', minWidth: 'max-content', fontFamily: 'mono' })}>
          {diff.hunks.map((hunk) => (
            <Fragment key={hunkHeader(hunk)}>
              <div className={css({ bg: 'surface-muted', color: 'text-muted', paddingInline: '3', paddingBlock: '1' })}>
                {hunkHeader(hunk)}
              </div>
              {hunk.lines.map((line) => (
                <div
                  // Unified-diff coordinates are file-global and strictly
                  // increasing, so a line's own numbers identify it.
                  key={`${line.type}:${line.fromLine ?? 'x'}:${line.toLine ?? 'y'}`}
                  data-line-type={line.type}
                  className={cx(
                    css({ display: 'flex' }),
                    line.type === 'removed' && css({ bg: 'error-surface' }),
                    line.type === 'added' && css({ bg: 'action-subtle' }),
                  )}
                >
                  <span
                    className={css({
                      color: 'text-muted',
                      width: '40px',
                      flexShrink: '0',
                      paddingInline: '2',
                      textAlign: 'end',
                      fontVariantNumeric: 'tabular-nums',
                      userSelect: 'none',
                    })}
                  >
                    {line.fromLine ?? ''}
                  </span>
                  <span
                    className={css({
                      color: 'text-muted',
                      width: '40px',
                      flexShrink: '0',
                      paddingInline: '2',
                      textAlign: 'end',
                      fontVariantNumeric: 'tabular-nums',
                      userSelect: 'none',
                    })}
                  >
                    {line.toLine ?? ''}
                  </span>
                  <span
                    className={cx(
                      css({ paddingInlineEnd: '4', whiteSpace: 'pre' }),
                      line.type === 'context' && css({ color: 'text-muted' }),
                    )}
                  >
                    {`${diffMarker(line.type)}${line.text}`}
                  </span>
                </div>
              ))}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}
