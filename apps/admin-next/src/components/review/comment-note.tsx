import { Button } from '@tuuject/koi-react/button';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Textarea } from '@tuuject/koi-react/textarea';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatTextIcon } from '@/components/icons.tsx';
import type { InvocationDetail } from '@/lib/api/invocations.ts';
import {
  type CommentableTimelineEvent,
  REVIEW_TEXT_MAX_CHARS,
  snapshotInvocationMeta,
  snapshotTimelineEvent,
} from '@/lib/review-export.ts';
import { timelineEventKey } from '@/lib/timeline.ts';
import { useReviewStore } from '@/stores/review.ts';

export function ReviewCommentEditor({
  label,
  placeholder,
  initialValue,
  onSave,
  onCancel,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly initialValue: string;
  readonly onSave: (text: string) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initialValue);

  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: '2',
        borderRadius: 'lg',
        borderWidth: '1px',
        borderColor: 'border',
        bg: 'surface-muted',
        padding: '3',
      })}
    >
      <Textarea
        aria-label={label}
        placeholder={placeholder}
        rows={3}
        maxLength={REVIEW_TEXT_MAX_CHARS}
        value={draft}
        dir="auto"
        onChange={(event) => setDraft(event.target.value.slice(0, REVIEW_TEXT_MAX_CHARS))}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            onSave(draft);
          }
        }}
      />
      <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
        <Button type="button" size="sm" color="primary" onClick={() => onSave(draft)}>
          {t('common.save')}
        </Button>
        <Button type="button" size="sm" variant="ghost" color="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

export function ReviewCommentNote({
  badgeLabel,
  text,
  editorLabel,
  editorPlaceholder,
  onSave,
  onDelete,
}: {
  readonly badgeLabel: string;
  readonly text: string;
  readonly editorLabel: string;
  readonly editorPlaceholder: string;
  readonly onSave: (text: string) => void;
  readonly onDelete: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <ReviewCommentEditor
        label={editorLabel}
        placeholder={editorPlaceholder}
        initialValue={text}
        onSave={(nextText) => {
          onSave(nextText);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: '2',
        borderRadius: 'lg',
        borderWidth: '1px',
        borderColor: 'border',
        borderInlineStartWidth: '3px',
        borderInlineStartColor: 'action',
        bg: 'surface-muted',
        padding: '3',
      })}
    >
      <div
        className={css({
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '2',
        })}
      >
        <span className={css({ textStyle: 'small', color: 'text-muted', fontWeight: 'medium' })}>{badgeLabel}</span>
        <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1' })}>
          <Button type="button" size="sm" variant="ghost" color="secondary" onClick={() => setEditing(true)}>
            {t('common.edit')}
          </Button>
          <Button type="button" size="sm" variant="ghost" color="error" onClick={onDelete}>
            {t('common.delete')}
          </Button>
        </div>
      </div>
      <p
        dir="auto"
        className={css({
          margin: '0',
          textStyle: 'body',
          color: 'text',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        })}
      >
        {text}
      </p>
    </div>
  );
}

export function EventReviewAffordance({
  invocation,
  event,
  position,
}: {
  readonly invocation: InvocationDetail;
  readonly event: CommentableTimelineEvent;
  readonly position: number;
}): ReactElement {
  const { t } = useTranslation();
  const anchor = timelineEventKey(event);
  const comment = useReviewStore((state) => state.invocations[invocation.id]?.comments[anchor]);
  const saveEventComment = useReviewStore((state) => state.saveEventComment);
  const deleteEventComment = useReviewStore((state) => state.deleteEventComment);
  const [adding, setAdding] = useState(false);

  const handleSave = (text: string): void => {
    saveEventComment(snapshotInvocationMeta(invocation), snapshotTimelineEvent(event, position), text);
    setAdding(false);
  };

  if (comment !== undefined) {
    return (
      <ReviewCommentNote
        badgeLabel={t('invocations.review.commentLabel')}
        text={comment.text}
        editorLabel={t('invocations.review.commentLabel')}
        editorPlaceholder={t('invocations.review.commentPlaceholder')}
        onSave={handleSave}
        onDelete={() => deleteEventComment(invocation.id, anchor)}
      />
    );
  }

  if (adding) {
    return (
      <ReviewCommentEditor
        label={t('invocations.review.commentLabel')}
        placeholder={t('invocations.review.commentPlaceholder')}
        initialValue=""
        onSave={handleSave}
        onCancel={() => setAdding(false)}
      />
    );
  }

  return (
    <div>
      <Button type="button" size="sm" variant="ghost" color="secondary" onClick={() => setAdding(true)}>
        <ChatTextIcon size={14} />
        {t('invocations.review.addComment')}
      </Button>
    </div>
  );
}
