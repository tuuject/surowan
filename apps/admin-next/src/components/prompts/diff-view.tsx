import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
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
    <div className="overflow-hidden rounded-lg border">
      <div className="bg-muted/40 border-b px-3 py-2 font-mono text-xs">
        {t('pages.prompts.diffTitle', { from: diff.from.seq, to: diff.to.seq })}
      </div>
      <div className="max-h-[32rem] overflow-auto">
        <pre className="min-w-max font-mono text-xs leading-relaxed">
          {diff.hunks.map((hunk) => (
            <Fragment key={hunkHeader(hunk)}>
              <div className="bg-muted/50 text-muted-foreground px-3 py-0.5">{hunkHeader(hunk)}</div>
              {hunk.lines.map((line) => (
                <div
                  // Unified-diff coordinates are file-global and strictly
                  // increasing, so a line's own numbers identify it.
                  key={`${line.type}:${line.fromLine ?? 'x'}:${line.toLine ?? 'y'}`}
                  data-line-type={line.type}
                  className={cn(
                    'flex',
                    line.type === 'removed' && 'bg-danger/10',
                    line.type === 'added' && 'bg-success/10',
                  )}
                >
                  <span className="text-muted-foreground w-10 shrink-0 px-2 text-right tabular-nums select-none">
                    {line.fromLine ?? ''}
                  </span>
                  <span className="text-muted-foreground w-10 shrink-0 px-2 text-right tabular-nums select-none">
                    {line.toLine ?? ''}
                  </span>
                  <span className={cn('pr-4 whitespace-pre', line.type === 'context' && 'text-muted-foreground')}>
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
