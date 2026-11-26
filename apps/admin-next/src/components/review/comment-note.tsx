import { Button, IconButton } from '@tuuject/koi-react/button';
import { Field } from '@tuuject/koi-react/field';
import { TrashIcon } from '@tuuject/koi-react/icons';
import { css, cx } from '@tuuject/koi-react/styled-system/css';
import { Textarea } from '@tuuject/koi-react/textarea';
import { sizes } from '@tuuject/koi-tokens/dimensions';
import { type ReactElement, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatTextIcon, EditIcon } from '@/components/icons.tsx';
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
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '3' })}>
      <Field label={label}>
        <Textarea
          // The editor only mounts from an Add or Edit click, which unmounts that button: keep focus in the flow.
          autoFocus
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
      </Field>
      <div className={css({ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '2' })}>
        <Button type="button" variant="ghost" color="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="button" color="primary" onClick={() => onSave(draft)}>
          {t('common.save')}
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
        gap: '1',
        borderRadius: 'xl',
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
          columnGap: '2',
        })}
      >
        <span
          className={css({
            display: 'inline-flex',
            alignItems: 'center',
            gap: '1',
            textStyle: 'small',
            color: 'text-muted',
          })}
        >
          <ChatTextIcon size={sizes['icon-xs']} className={css({ flexShrink: '0' })} />
          {badgeLabel}
        </span>
        {/* Row actions: no gap, pulled outward by the sm ghost padding so the last label lines up with the text. */}
        <div className={css({ display: 'flex', alignItems: 'center', marginInlineEnd: '-2', marginBlock: '-1' })}>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            color="secondary"
            iconStart={<EditIcon />}
            onClick={() => setEditing(true)}
          >
            {t('common.edit')}
          </Button>
          <Button type="button" size="sm" variant="ghost" color="error" iconStart={<TrashIcon />} onClick={onDelete}>
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

/**
 * One reviewable thing on the Overview: a chat bubble or a step. The Add button
 * sits beside the content on the side facing the conversation (after a member's
 * bubble, before the bot's), so the content keeps its edge; it shows on hover or
 * keyboard focus (always on devices without hover). The footer (meta line and
 * panels), then a saved comment or an open editor, sit underneath on the same side.
 */
export function ReviewableItem({
  invocation,
  event,
  position,
  align = 'start',
  header,
  footer,
  children,
}: {
  readonly invocation: InvocationDetail;
  readonly event: CommentableTimelineEvent;
  readonly position: number;
  readonly align?: 'start' | 'end';
  readonly header?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
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

  return (
    <article
      className={cx(
        'group',
        css({
          display: 'flex',
          flexDirection: 'column',
          alignItems: align === 'end' ? 'flex-end' : 'flex-start',
          gap: '1',
          minWidth: '0',
        }),
      )}
    >
      {header}
      <div
        className={css({
          display: 'flex',
          // Reversed on the end side: the content stays on its edge, the button lands on its inner side.
          flexDirection: align === 'end' ? 'row-reverse' : 'row',
          alignItems: 'center',
          gap: '1',
          minWidth: '0',
          maxWidth: '100%',
        })}
      >
        {children}
        {comment === undefined && !adding ? (
          // Icon-only on narrow screens, so the hidden control never pushes the content onto two lines.
          <span className={revealOnHoverClass}>
            <IconButton
              variant="ghost"
              color="secondary"
              label={t('invocations.review.addComment')}
              icon={<ChatTextIcon />}
              className={css({ display: { base: 'inline-flex', md: 'none' } })}
              onClick={() => setAdding(true)}
            />
            <Button
              type="button"
              variant="ghost"
              color="secondary"
              iconStart={<ChatTextIcon />}
              className={css({ display: { base: 'none', md: 'inline-flex' } })}
              onClick={() => setAdding(true)}
            >
              {t('invocations.review.addComment')}
            </Button>
          </span>
        ) : null}
      </div>
      {footer === undefined ? null : <div className={footerClass}>{footer}</div>}
      {comment !== undefined ? (
        <div className={noteClass}>
          <ReviewCommentNote
            badgeLabel={t('invocations.review.commentLabel')}
            text={comment.text}
            editorLabel={t('invocations.review.commentLabel')}
            editorPlaceholder={t('invocations.review.commentPlaceholder')}
            onSave={handleSave}
            onDelete={() => deleteEventComment(invocation.id, anchor)}
          />
        </div>
      ) : adding ? (
        <div className={noteClass}>
          <ReviewCommentEditor
            label={t('invocations.review.commentLabel')}
            placeholder={t('invocations.review.commentPlaceholder')}
            initialValue=""
            onSave={handleSave}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : null}
    </article>
  );
}

// Hidden only where a pointer can hover: a touch screen has no way to reveal it.
const revealOnHoverClass = css({
  display: 'inline-flex',
  flexShrink: '0',
  // Out of the line height: a one-line title must not grow to the button's 36px.
  marginBlock: '-2',
  transitionProperty: 'opacity',
  transitionDuration: 'fast',
  '@media (hover: hover)': { opacity: '0' },
  _groupHover: { opacity: '1' },
  _groupFocusWithin: { opacity: '1' },
});

// The footer's own gap above it: the meta line sits a step further from the content than the header does.
const footerClass = css({ width: '100%', minWidth: '0', marginBlockStart: '1' });
// As wide as a chat bubble can be.
const noteClass = css({ width: '100%', maxWidth: '480px', marginBlockStart: '1' });
