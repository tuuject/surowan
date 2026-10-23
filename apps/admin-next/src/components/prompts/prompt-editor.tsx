import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MonoValue, ToneBadge } from '@/components/business';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

import { formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { type Notice, type PromptDraft, sourceLabelKey, sourceTone } from './prompt-draft';
import type { PromptDocument, PromptVersionItem } from '@/lib/api/prompts.ts';

/** The same limit the API enforces on a version note. */
const MAX_NOTE_CHARS = 200;

/** Save outcomes: a recorded/applied prompt, a no-op, or one of the write failures. */
function WriteNotice({ notice }: { readonly notice: Notice | null }): React.ReactElement | null {
  const { t } = useTranslation();
  switch (notice?.kind) {
    case undefined:
      return null;
    case 'saved':
      return (
        <p role="status" className="text-success text-sm">
          {t('pages.prompts.saved')}
        </p>
      );
    case 'unchanged':
      return (
        <p role="status" className="text-muted-foreground text-sm">
          {t('pages.prompts.unchanged')}
        </p>
      );
    case 'conflict':
      return (
        <p role="alert" className="text-destructive text-sm">
          {t('pages.prompts.conflict')}
        </p>
      );
    case 'apply_failed':
      return (
        <Alert variant="destructive">
          <AlertTitle>{t('pages.prompts.applyFailedTitle')}</AlertTitle>
          <AlertDescription>{notice.message}</AlertDescription>
        </Alert>
      );
    case 'error':
      return (
        <p role="alert" className="text-destructive text-sm break-words">
          {notice.message}
        </p>
      );
  }
}

/**
 * The textarea is seeded from the file view and re-seeded whenever that view's
 * content hash changes (scope switch, refetch after a conflict): the draft only
 * survives while it still describes the content its hash pins.
 */
export function PromptEditor({
  file,
  applied,
  notice,
  saving,
  onSave,
}: {
  readonly file: PromptDocument;
  readonly applied: PromptVersionItem | null;
  readonly notice: Notice | null;
  readonly saving: boolean;
  readonly onSave: (draft: PromptDraft) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const current =
    draft !== null && draft.hash === file.content_hash
      ? draft
      : { hash: file.content_hash, text: file.prompt, note: '' };
  const matches = applied !== null && applied.content_hash === file.content_hash;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="prompt-text">{t('pages.prompts.promptLabel')}</Label>
        <Textarea
          id="prompt-text"
          value={current.text}
          spellCheck={false}
          placeholder={t('pages.prompts.promptPlaceholder')}
          className="min-h-96 font-mono text-xs"
          onChange={(event) => setDraft({ hash: file.content_hash, text: event.target.value, note: current.note })}
        />
        <p className="text-muted-foreground text-xs">{t('pages.prompts.editorHint')}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="prompt-note">{t('pages.prompts.noteLabel')}</Label>
        <Input
          id="prompt-note"
          value={current.note}
          maxLength={MAX_NOTE_CHARS}
          placeholder={t('pages.prompts.notePlaceholder')}
          onChange={(event) => setDraft({ hash: file.content_hash, text: current.text, note: event.target.value })}
        />
        <p className="text-muted-foreground text-xs">{t('pages.prompts.noteHint', { count: MAX_NOTE_CHARS })}</p>
      </div>
      <div className="bg-muted/30 space-y-1.5 rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('pages.prompts.appliedVersion')}</span>
          {applied === null ? (
            <span className="text-muted-foreground">{t('pages.prompts.noVersions')}</span>
          ) : (
            <>
              <MonoValue value={`v${applied.seq}`} />
              <ToneBadge tone={sourceTone(applied.source)}>{t(sourceLabelKey(applied.source))}</ToneBadge>
              <span className="text-muted-foreground text-xs tabular-nums">{formatTime(applied.created_at)}</span>
              {applied.created_by === null ? null : (
                <span className="text-muted-foreground text-xs">{applied.created_by}</span>
              )}
            </>
          )}
        </div>
        {applied === null ? null : (
          <p className={cn('text-xs', matches ? 'text-success' : 'text-warning')}>
            {matches ? t('pages.prompts.fileMatches') : t('pages.prompts.fileDiffers')}
          </p>
        )}
      </div>
      {file.scope === 'group' && file.prompt.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('pages.prompts.groupCreationHint')}</p>
      ) : null}
      <WriteNotice notice={notice} />
      <Button type="button" disabled={saving} onClick={() => onSave(current)}>
        {saving ? t('pages.prompts.saving') : t('pages.prompts.save')}
      </Button>
    </div>
  );
}
