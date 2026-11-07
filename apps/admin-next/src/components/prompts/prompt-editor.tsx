import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MonoValue, ToneBadge } from '@/components/business';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Input } from '@tuuject/koi-react/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@tuuject/koi-react/textarea';
import type { PromptDocument, PromptVersionItem } from '@/lib/api/prompts.ts';
import { formatTime } from '@/lib/format';
import { type Notice, type PromptDraft, sourceLabelKey, sourceTone } from './prompt-draft';
import { css, cx } from '@tuuject/koi-react/styled-system/css';

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
        <p role="status" className={css({ textStyle: 'body', color: 'text-brand' })}>
          {t('pages.prompts.saved')}
        </p>
      );
    case 'unchanged':
      return (
        <p role="status" className={css({ textStyle: 'body', color: 'text-muted' })}>
          {t('pages.prompts.unchanged')}
        </p>
      );
    case 'conflict':
      return (
        <p role="alert" className={css({ textStyle: 'body', color: 'error-text' })}>
          {t('pages.prompts.conflict')}
        </p>
      );
    case 'apply_failed':
      return (
        <Alert tone="error" title={t('pages.prompts.applyFailedTitle')}>
          {notice.message}
        </Alert>
      );
    case 'error':
      return (
        <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
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
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
        <Label htmlFor="prompt-text">{t('pages.prompts.promptLabel')}</Label>
        <Textarea
          id="prompt-text"
          value={current.text}
          spellCheck={false}
          placeholder={t('pages.prompts.promptPlaceholder')}
          className={css({ textStyle: 'small', minHeight: '384px', fontFamily: 'mono' })}
          onChange={(event) => setDraft({ hash: file.content_hash, text: event.target.value, note: current.note })}
        />
        <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.prompts.editorHint')}</p>
      </div>
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
        <Label htmlFor="prompt-note">{t('pages.prompts.noteLabel')}</Label>
        <Input
          id="prompt-note"
          value={current.note}
          maxLength={MAX_NOTE_CHARS}
          placeholder={t('pages.prompts.notePlaceholder')}
          onChange={(event) => setDraft({ hash: file.content_hash, text: current.text, note: event.target.value })}
        />
        <p className={css({ textStyle: 'small', color: 'text-muted' })}>
          {t('pages.prompts.noteHint', { count: MAX_NOTE_CHARS })}
        </p>
      </div>
      <div
        className={css({
          bg: 'surface-muted',
          '& > :not(:last-child)': { marginBlockEnd: '2' },
          borderRadius: 'xl',
          borderWidth: '1px',
          borderColor: 'border',
          padding: '3',
        })}
      >
        <div className={css({ textStyle: 'body', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
          <span className={css({ color: 'text-muted' })}>{t('pages.prompts.appliedVersion')}</span>
          {applied === null ? (
            <span className={css({ color: 'text-muted' })}>{t('pages.prompts.noVersions')}</span>
          ) : (
            <>
              <MonoValue value={`v${applied.seq}`} />
              <ToneBadge tone={sourceTone(applied.source)}>{t(sourceLabelKey(applied.source))}</ToneBadge>
              <span className={css({ textStyle: 'small', color: 'text-muted', fontVariantNumeric: 'tabular-nums' })}>
                {formatTime(applied.created_at)}
              </span>
              {applied.created_by === null ? null : (
                <span className={css({ textStyle: 'small', color: 'text-muted' })}>{applied.created_by}</span>
              )}
            </>
          )}
        </div>
        {applied === null ? null : (
          <p
            className={cx(
              css({ textStyle: 'small' }),
              matches ? css({ color: 'text-brand' }) : css({ color: 'warning-text' }),
            )}
          >
            {matches ? t('pages.prompts.fileMatches') : t('pages.prompts.fileDiffers')}
          </p>
        )}
      </div>
      {file.scope === 'group' && file.prompt.length === 0 ? (
        <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.prompts.groupCreationHint')}</p>
      ) : null}
      <WriteNotice notice={notice} />
      <Button type="button" disabled={saving} onClick={() => onSave(current)}>
        {saving ? t('pages.prompts.saving') : t('pages.prompts.save')}
      </Button>
    </div>
  );
}
