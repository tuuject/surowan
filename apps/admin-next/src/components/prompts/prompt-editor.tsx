import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Field } from '@tuuject/koi-react/field';
import { SuccessIcon, WarningIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { sizes } from '@tuuject/koi-tokens/dimensions';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MonoValue, ToneBadge } from '@/components/business';
import type { PromptDocument, PromptVersionItem } from '@/lib/api/prompts.ts';
import { formatTime } from '@/lib/format';
import { MarkdownInput } from './markdown-input';
import { type Notice, type PromptDraft, sourceLabelKey, sourceTone } from './prompt-draft';

/** The same limit the API enforces on a version note. */
const MAX_NOTE_CHARS = 200;

/** Save outcomes: a recorded/applied prompt, a no-op, or one of the write failures. */
function WriteNotice({ notice }: { readonly notice: Notice | null }): ReactElement | null {
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
 * The editor is seeded from the file view and re-seeded whenever that view's
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
}): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const current =
    draft !== null && draft.hash === file.content_hash
      ? draft
      : { hash: file.content_hash, text: file.prompt, note: '' };
  const matches = applied !== null && applied.content_hash === file.content_hash;
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
      <Field id="prompt-text" label={t('pages.prompts.promptLabel')}>
        <MarkdownInput
          id="prompt-text"
          value={current.text}
          placeholder={t('pages.prompts.promptPlaceholder')}
          minHeight="384px"
          onChange={(text) => setDraft({ hash: file.content_hash, text, note: current.note })}
        />
      </Field>
      <Field
        id="prompt-note"
        label={t('pages.prompts.noteLabel')}
        optional
        help={t('pages.prompts.noteHint', { count: MAX_NOTE_CHARS })}
      >
        <Input
          value={current.note}
          maxLength={MAX_NOTE_CHARS}
          placeholder={t('pages.prompts.notePlaceholder')}
          onChange={(event) => setDraft({ hash: file.content_hash, text: current.text, note: event.target.value })}
        />
      </Field>
      {/* Plain status lines: the editor already sits in a card, so no second frame around them. */}
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '1' })}>
        <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
          <span className={css({ color: 'text-muted' })}>{t('pages.prompts.appliedVersion')}</span>
          {applied === null ? (
            <span className={css({ color: 'text-muted' })}>{t('pages.prompts.noVersions')}</span>
          ) : (
            <>
              <MonoValue value={`v${applied.seq}`} />
              <ToneBadge tone={sourceTone(applied.source)}>{t(sourceLabelKey(applied.source))}</ToneBadge>
              <span className={css({ textStyle: 'small', color: 'text-muted' })}>{formatTime(applied.created_at)}</span>
              {applied.created_by === null ? null : (
                <span className={css({ textStyle: 'small', color: 'text-muted' })}>{applied.created_by}</span>
              )}
            </>
          )}
        </div>
        {applied === null ? null : (
          <p
            className={css(
              { margin: '0', display: 'flex', alignItems: 'center', gap: '1', textStyle: 'small' },
              matches ? { color: 'text-brand' } : { color: 'warning-text' },
            )}
          >
            {matches ? <SuccessIcon size={sizes['icon-xs']} /> : <WarningIcon size={sizes['icon-xs']} />}
            {matches ? t('pages.prompts.fileMatches') : t('pages.prompts.fileDiffers')}
          </p>
        )}
      </div>
      {file.scope === 'group' && file.prompt.length === 0 ? (
        <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.prompts.groupCreationHint')}</p>
      ) : null}
      <WriteNotice notice={notice} />
      <div>
        <Button loading={saving} loadingLabel={t('pages.prompts.saving')} onClick={() => onSave(current)}>
          {t('pages.prompts.save')}
        </Button>
      </div>
    </div>
  );
}
