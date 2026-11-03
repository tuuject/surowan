import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { ToolContentPart } from '@/lib/api/invocations.ts';

function ResultImage({
  part,
  index,
}: {
  readonly part: Extract<ToolContentPart, { type: 'image' }>;
  readonly index: number;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const label = t('invocations.toolImage.label', { index });
  if (failed) {
    return (
      <p role="status" className="text-destructive text-sm">
        {t('invocations.toolImage.unavailable', { index })}
      </p>
    );
  }
  return (
    <Dialog>
      <DialogTrigger
        className="block cursor-zoom-in rounded border p-1"
        aria-label={t('invocations.toolImage.enlarge', { index })}
      >
        <img
          src={part.url}
          alt={label}
          loading="lazy"
          className="max-h-64 max-w-full object-contain"
          onError={() => setFailed(true)}
        />
      </DialogTrigger>
      <DialogContent className="sm:max-w-5xl" aria-describedby={undefined}>
        <DialogTitle>{label}</DialogTitle>
        <img
          src={part.url}
          alt={label}
          className="max-h-[80vh] w-full object-contain"
          onError={() => setFailed(true)}
        />
      </DialogContent>
    </Dialog>
  );
}

export function ToolResult({ content }: { readonly content: readonly ToolContentPart[] }) {
  let imageIndex = 0;
  const occurrences = new Map<string, number>();
  return (
    <div className="space-y-2" data-tool-result="true">
      {content.map((part) => {
        const identity = part.type === 'text' ? part.text : part.asset_id;
        const occurrence = (occurrences.get(identity) ?? 0) + 1;
        occurrences.set(identity, occurrence);
        const key = `${part.type}:${identity}:${occurrence}`;
        return part.type === 'text' ? (
          <p key={key} className="text-sm break-words whitespace-pre-wrap">
            {part.text}
          </p>
        ) : (
          <ResultImage key={key} part={part} index={++imageIndex} />
        );
      })}
    </div>
  );
}
