import { Button } from '@tuuject/koi-react/button';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatTextIcon } from '@/components/icons.tsx';
import { Panel } from '@/components/layout/panel.tsx';
import { AppLink } from '@/components/router-links.tsx';
import type { InvocationDetail } from '@/lib/api/invocations.ts';
import { snapshotInvocationMeta } from '@/lib/review-export.ts';
import { useReviewStore } from '@/stores/review.ts';
import { ReviewCommentEditor, ReviewCommentNote } from './comment-note.tsx';

export function InvocationReviewPanel({ invocation }: { readonly invocation: InvocationDetail }): ReactElement {
  const { t } = useTranslation();
  const reviewedInvocation = useReviewStore((state) => state.invocations[invocation.id]);
  const draftInvocationCount = useReviewStore((state) => Object.keys(state.invocations).length);
  const saveOverallComment = useReviewStore((state) => state.saveOverallComment);
  const [addingOverall, setAddingOverall] = useState(false);

  const thisCommentCount = reviewedInvocation === undefined ? 0 : Object.keys(reviewedInvocation.comments).length;
  const overallText = reviewedInvocation?.overall ?? '';

  const handleSaveOverall = (text: string): void => {
    saveOverallComment(snapshotInvocationMeta(invocation), text);
    setAddingOverall(false);
  };

  return (
    <Panel
      title={t('invocations.review.panelTitle')}
      description={
        <span>
          {t('invocations.review.thisInvocationCount', { count: thisCommentCount })}
          {' · '}
          {t('invocations.review.draftInvocationsCount', { count: draftInvocationCount })}
        </span>
      }
      action={<AppLink to="/reviews">{t('invocations.review.openDraft')}</AppLink>}
    >
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '3' })}>
        {overallText.length > 0 ? (
          <ReviewCommentNote
            badgeLabel={t('invocations.review.overallComment')}
            text={overallText}
            editorLabel={t('invocations.review.overallComment')}
            editorPlaceholder={t('invocations.review.overallPlaceholder')}
            onSave={handleSaveOverall}
            onDelete={() => handleSaveOverall('')}
          />
        ) : addingOverall ? (
          <ReviewCommentEditor
            label={t('invocations.review.overallComment')}
            placeholder={t('invocations.review.overallPlaceholder')}
            initialValue=""
            onSave={handleSaveOverall}
            onCancel={() => setAddingOverall(false)}
          />
        ) : (
          <div>
            <Button type="button" size="sm" variant="soft" color="secondary" onClick={() => setAddingOverall(true)}>
              <ChatTextIcon size={14} />
              {t('invocations.review.addOverallComment')}
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}
