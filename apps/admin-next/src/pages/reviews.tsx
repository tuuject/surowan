import { Button } from '@tuuject/koi-react/button';
import { Empty } from '@tuuject/koi-react/empty';
import { Field } from '@tuuject/koi-react/field';
import { TrashIcon } from '@tuuject/koi-react/icons';
import { RadioGroup } from '@tuuject/koi-react/radio-group';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Textarea } from '@tuuject/koi-react/textarea';
import type { TFunction } from 'i18next';
import { type ReactElement, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type BadgeSemantic,
  ConfirmDialog,
  LazyDetails,
  ListPageHeader,
  TechText,
  TimeText,
  ToneBadge,
} from '@/components/business';
import { ChatTextIcon, CopyIcon, DownloadIcon } from '@/components/icons.tsx';
import { Panel } from '@/components/layout/panel.tsx';
import { ReviewCommentEditor, ReviewCommentNote } from '@/components/review/comment-note.tsx';
import { AppLink, ButtonLink } from '@/components/router-links.tsx';
import { downloadTextFile } from '@/lib/download.ts';
import {
  buildReviewExportJson,
  buildReviewMarkdown,
  REVIEW_TEXT_MAX_CHARS,
  type ReviewComment,
  type ReviewDraftData,
  type ReviewedInvocation,
  type ReviewEventKind,
  reviewExportFilename,
  sortReviewComments,
  sortReviewedInvocations,
} from '@/lib/review-export.ts';
import { toast } from '@/lib/toast.ts';
import { useReviewStore } from '@/stores/review.ts';

const KIND_TONES: Readonly<Record<ReviewEventKind, BadgeSemantic>> = {
  tool_call: 'success',
  agent_message: 'warning',
  model_call: 'info',
  context_message: 'neutral',
};

function formatLocalizedCommentLabel(t: TFunction, comment: ReviewComment): string {
  switch (comment.kind) {
    case 'tool_call':
      return t('invocations.review.eventLabels.toolCall', { name: comment.subject });
    case 'agent_message':
      switch (comment.subject) {
        case 'assistant':
          return t('invocations.invocationDetail.agentRoles.assistantLabel');
        case 'tool_result':
          return t('invocations.invocationDetail.agentRoles.toolResultLabel');
        case 'harness_nudge':
          return t('invocations.invocationDetail.agentRoles.harnessNudgeLabel');
        default:
          return comment.subject;
      }
    case 'model_call':
      return t('invocations.review.eventLabels.modelCall', {
        model: comment.subject,
        attempt: comment.attempt ?? 1,
      });
    case 'context_message': {
      const sender =
        comment.subject.trim().length > 0
          ? comment.subject
          : t('invocations.invocationDetail.contextMessage.unknownSender');
      return t('invocations.review.eventLabels.contextMessage', { sender });
    }
  }
}

function ReviewedInvocationSection({ invocation }: { readonly invocation: ReviewedInvocation }): ReactElement {
  const { t } = useTranslation();
  const updateOverallComment = useReviewStore((state) => state.updateOverallComment);
  const updateEventComment = useReviewStore((state) => state.updateEventComment);
  const deleteEventComment = useReviewStore((state) => state.deleteEventComment);
  const removeInvocation = useReviewStore((state) => state.removeInvocation);
  const [addingOverall, setAddingOverall] = useState(false);

  const orderedComments = useMemo(() => sortReviewComments(invocation.comments), [invocation.comments]);
  const commentCount = orderedComments.length;

  const handleSaveOverall = (text: string): void => {
    updateOverallComment(invocation.id, text);
    setAddingOverall(false);
  };

  return (
    <Panel
      title={
        <span className={css({ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
          <AppLink to="/invocations/$invocationId" params={{ invocationId: invocation.id }}>
            {t('invocations.invocationDetail.title', { id: invocation.id })}
          </AppLink>
          <span dir="auto" className={css({ textStyle: 'body', color: 'text-muted', fontWeight: 'normal' })}>
            {invocation.chatLabel}
          </span>
        </span>
      }
      description={
        <span>
          <TimeText value={invocation.createdAt} />
          {' · '}
          {t('invocations.review.commentCount', { count: commentCount })}
        </span>
      }
      action={
        <Button type="button" size="sm" variant="ghost" color="error" onClick={() => removeInvocation(invocation.id)}>
          <TrashIcon size={14} />
          {t('invocations.review.removeInvocation')}
        </Button>
      }
    >
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
        {invocation.overall.length > 0 ? (
          <ReviewCommentNote
            badgeLabel={t('invocations.review.overallComment')}
            text={invocation.overall}
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

        {orderedComments.length > 0 ? (
          <ol
            className={css({
              listStyle: 'none',
              padding: '0',
              margin: '0',
              display: 'flex',
              flexDirection: 'column',
              gap: '3',
            })}
          >
            {orderedComments.map((comment) => (
              <li
                key={comment.anchor}
                className={css({
                  borderTopWidth: '1px',
                  borderColor: 'divider',
                  paddingBlockStart: '3',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2',
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
                  <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
                    <ToneBadge tone={KIND_TONES[comment.kind]}>
                      {t(`invocations.review.kinds.${comment.kind}`)}
                    </ToneBadge>
                    <span dir="auto" className={css({ textStyle: 'label' })}>
                      {formatLocalizedCommentLabel(t, comment)}
                    </span>
                    <code
                      className={css({
                        textStyle: 'small',
                        borderRadius: 'lg',
                        bg: 'surface-muted',
                        paddingInline: '1',
                        paddingBlock: '1',
                        fontFamily: 'mono',
                      })}
                    >
                      <TechText>{comment.ref}</TechText>
                    </code>
                  </div>
                  <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                    <TimeText value={comment.at} />
                  </span>
                </div>
                {comment.excerpt !== null ? (
                  <p
                    dir="auto"
                    className={css({
                      margin: '0',
                      textStyle: 'small',
                      color: 'text-muted',
                      whiteSpace: 'pre-wrap',
                      overflowWrap: 'anywhere',
                    })}
                  >
                    {comment.excerpt}
                  </p>
                ) : null}
                <ReviewCommentNote
                  badgeLabel={t('invocations.review.commentLabel')}
                  text={comment.text}
                  editorLabel={t('invocations.review.commentLabel')}
                  editorPlaceholder={t('invocations.review.commentPlaceholder')}
                  onSave={(nextText) => updateEventComment(invocation.id, comment.anchor, nextText)}
                  onDelete={() => deleteEventComment(invocation.id, comment.anchor)}
                />
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </Panel>
  );
}

export default function ReviewsPage(): ReactElement {
  const { t } = useTranslation();
  const goal = useReviewStore((state) => state.goal);
  const purpose = useReviewStore((state) => state.purpose);
  const invocations = useReviewStore((state) => state.invocations);
  const setGoal = useReviewStore((state) => state.setGoal);
  const setPurpose = useReviewStore((state) => state.setPurpose);
  const clearDraft = useReviewStore((state) => state.clearDraft);

  const [pendingExportAction, setPendingExportAction] = useState<'copy' | 'download' | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  const sortedInvocations = useMemo(() => sortReviewedInvocations(invocations), [invocations]);
  const previewMarkdown = useMemo(
    () => buildReviewMarkdown({ goal, purpose, invocations }, new Date()),
    [goal, purpose, invocations],
  );

  const handleConfirmExport = async (): Promise<void> => {
    if (pendingExportAction === null) {
      return;
    }
    const snapshot: ReviewDraftData = { goal, purpose, invocations };
    const now = new Date();
    const markdown = buildReviewMarkdown(snapshot, now);
    if (pendingExportAction === 'download') {
      downloadTextFile(reviewExportFilename(now), markdown, 'text/markdown;charset=utf-8');
      clearDraft();
      setPendingExportAction(null);
      toast.success(t('invocations.review.exportedAndCleared'));
      return;
    }
    const exportedFingerprint = JSON.stringify(buildReviewExportJson(snapshot, new Date(0)));
    setExportBusy(true);
    try {
      await navigator.clipboard.writeText(markdown);
      setExportBusy(false);
      setPendingExportAction(null);
      void useReviewStore.persist.rehydrate();
      const latest = useReviewStore.getState();
      const latestFingerprint = JSON.stringify(
        buildReviewExportJson(
          { goal: latest.goal, purpose: latest.purpose, invocations: latest.invocations },
          new Date(0),
        ),
      );
      if (latestFingerprint !== exportedFingerprint) {
        toast.info(t('invocations.review.copiedDraftChanged'));
        return;
      }
      clearDraft();
      toast.success(t('invocations.review.exportedAndCleared'));
    } catch {
      setExportBusy(false);
      setPendingExportAction(null);
      toast.error(t('invocations.review.copyFailed'));
    }
  };

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('layout.nav.reviews')} />
      <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>
        {t('invocations.review.browserOnlyNote')}
      </p>

      {sortedInvocations.length === 0 ? (
        <Panel title={t('invocations.review.panelTitle')}>
          <Empty
            variant="plain"
            title={t('invocations.review.emptyTitle')}
            description={t('invocations.review.emptyDescription')}
            action={
              <ButtonLink to="/invocations" variant="soft" color="secondary">
                {t('invocations.review.browseInvocations')}
              </ButtonLink>
            }
          />
        </Panel>
      ) : (
        <>
          <Panel
            title={t('invocations.review.exportPanelTitle')}
            action={
              <>
                <Button type="button" size="sm" color="primary" onClick={() => setPendingExportAction('download')}>
                  <DownloadIcon size={14} />
                  {t('invocations.review.downloadMarkdown')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="soft"
                  color="secondary"
                  onClick={() => setPendingExportAction('copy')}
                >
                  <CopyIcon size={14} />
                  {t('invocations.review.copyMarkdown')}
                </Button>
                <Button type="button" size="sm" variant="ghost" color="error" onClick={() => setConfirmClearOpen(true)}>
                  <TrashIcon size={14} />
                  {t('invocations.review.clearDraft')}
                </Button>
              </>
            }
          >
            <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
              <section aria-label={t('invocations.review.purposeLabel')}>
                <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
                  <div className={css({ textStyle: 'label' })}>{t('invocations.review.purposeLabel')}</div>
                  <RadioGroup
                    orientation="horizontal"
                    value={purpose}
                    onChange={(value) => setPurpose(value === 'develop' ? 'develop' : 'tune')}
                    options={[
                      { value: 'tune', label: t('invocations.review.purposeTune') },
                      { value: 'develop', label: t('invocations.review.purposeDevelop') },
                    ]}
                  />
                </div>
              </section>

              <Field label={t('invocations.review.goalLabel')} help={t('invocations.review.goalHelp')}>
                <Textarea
                  rows={3}
                  maxLength={REVIEW_TEXT_MAX_CHARS}
                  value={goal}
                  placeholder={t('invocations.review.goalPlaceholder')}
                  dir="auto"
                  onChange={(event) => setGoal(event.target.value)}
                />
              </Field>

              <LazyDetails summary={t('invocations.review.previewMarkdown')}>
                <pre
                  dir="ltr"
                  className={css({
                    textStyle: 'small',
                    fontFamily: 'mono',
                    maxHeight: '360px',
                    overflow: 'auto',
                    borderRadius: 'lg',
                    borderWidth: '1px',
                    borderColor: 'border',
                    bg: 'surface-muted',
                    padding: '3',
                    overflowWrap: 'anywhere',
                    whiteSpace: 'pre-wrap',
                  })}
                >
                  {previewMarkdown}
                </pre>
              </LazyDetails>
            </div>
          </Panel>

          <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
            {sortedInvocations.map((invocation) => (
              <ReviewedInvocationSection key={invocation.id} invocation={invocation} />
            ))}
          </div>
        </>
      )}

      <ConfirmDialog
        open={pendingExportAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingExportAction(null);
          }
        }}
        title={t('invocations.review.exportConfirmTitle')}
        description={t('invocations.review.exportConfirmDescription')}
        confirmText={t('invocations.review.exportConfirmButton')}
        cancelText={t('common.cancel')}
        pending={exportBusy}
        error={null}
        onConfirm={() => {
          void handleConfirmExport();
        }}
      />

      <ConfirmDialog
        open={confirmClearOpen}
        onOpenChange={setConfirmClearOpen}
        title={t('invocations.review.clearConfirmTitle')}
        description={t('invocations.review.clearConfirmDescription')}
        confirmText={t('invocations.review.clearConfirmButton')}
        cancelText={t('common.cancel')}
        destructive
        pending={false}
        error={null}
        onConfirm={() => {
          clearDraft();
          setConfirmClearOpen(false);
          toast.success(t('invocations.review.draftCleared'));
        }}
      />
    </div>
  );
}
