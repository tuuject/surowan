import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@tuuject/koi-react/dialog';
import type { ToolContentPart } from '@/lib/api/invocations.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

function ResultImage({
  part,
  index,
}: {
  readonly part: Extract<ToolContentPart, { type: 'image' }>;
  readonly index: number;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const label = t('invocations.toolImage.label', { index });
  if (failed) {
    return (
      <p role="status" className={css({ textStyle: 'body', color: 'error-text' })}>
        {t('invocations.toolImage.unavailable', { index })}
      </p>
    );
  }
  return (
    <>
      <button
        type="button"
        className={css({
          display: 'block',
          cursor: 'zoom-in',
          borderRadius: 'xl',
          borderWidth: '1px',
          borderColor: 'border',
          padding: '1',
          bg: 'surface',
          transitionProperty: 'border-color',
          transitionDuration: 'fast',
          _hover: { borderColor: 'border-hover' },
          _focusVisible: { outline: '2px solid', outlineColor: 'focus-ring', outlineOffset: '2px' },
        })}
        aria-label={t('invocations.toolImage.enlarge', { index })}
        onClick={() => setOpen(true)}
      >
        <img
          src={part.url}
          alt={label}
          loading="lazy"
          className={css({ maxHeight: '256px', maxWidth: '100%', objectFit: 'contain', borderRadius: 'lg' })}
          onError={() => setFailed(true)}
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen} title={label} size="lg">
        <img
          src={part.url}
          alt={label}
          className={css({ maxHeight: '70vh', width: '100%', objectFit: 'contain' })}
          onError={() => setFailed(true)}
        />
      </Dialog>
    </>
  );
}

export function ToolResult({ content }: { readonly content: readonly ToolContentPart[] }) {
  let imageIndex = 0;
  const occurrences = new Map<string, number>();
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })} data-tool-result="true">
      {content.map((part) => {
        const identity = part.type === 'text' ? part.text : part.asset_id;
        const occurrence = (occurrences.get(identity) ?? 0) + 1;
        occurrences.set(identity, occurrence);
        const key = `${part.type}:${identity}:${occurrence}`;
        return part.type === 'text' ? (
          <p key={key} className={css({ textStyle: 'body', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' })}>
            {part.text}
          </p>
        ) : (
          <ResultImage key={key} part={part} index={++imageIndex} />
        );
      })}
    </div>
  );
}
