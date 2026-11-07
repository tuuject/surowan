import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  ConfirmDialog,
  ListFooter,
  ListPageHeader,
  ListSearchForm,
  ListToolbar,
  MonoValue,
  QuerySelectField,
  TableShell,
  TextValue,
  ToneBadge,
  useClientPagination,
} from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { DiffView } from '@/components/prompts/diff-view';
import { type Notice, type PromptDraft, sourceLabelKey, sourceTone } from '@/components/prompts/prompt-draft';
import { PromptEditor } from '@/components/prompts/prompt-editor';
import { Button } from '@tuuject/koi-react/button';
import { Skeleton } from '@tuuject/koi-react/skeleton';
import { ApiError } from '@/lib/api/core.ts';
import type { PromptSaveResponse, PromptScopeRef, PromptVersionItem } from '@/lib/api/prompts.ts';
import { cancelPromptRunning, failedPromptVersion, restorePromptVersion, savePrompt } from '@/lib/api/prompts.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { chatQuery, useListQuery } from '@/lib/list-query';
import { chatsQuery, promptDiffQuery, promptDocumentQuery, promptVersionsQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

const GLOBAL_SCOPE_VALUE = 'global';
const CHAT_SCOPE_PREFIX = 'chat:';
const PROMPT_CONFLICT_CODE = 'prompt_conflict';
const EMPTY_SCOPE = { chat: '' };
const EMPTY_COMPARE = { from: '', to: '' };

function scopeOfValue(value: string): PromptScopeRef {
  return value.startsWith(CHAT_SCOPE_PREFIX)
    ? { scope: 'group', chat: value.slice(CHAT_SCOPE_PREFIX.length) }
    : { scope: 'global' };
}

export default function PromptsPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const chats = useQuery(chatsQuery);
  const query = useListQuery(EMPTY_SCOPE);
  const chat = chatQuery(query.value.chat);
  const scopeValue = chat === undefined ? GLOBAL_SCOPE_VALUE : `${CHAT_SCOPE_PREFIX}${chat}`;
  const scope = scopeOfValue(scopeValue);
  const fileQuery = useQuery(promptDocumentQuery(scope));
  const versions = useQuery(promptVersionsQuery(scope));
  const [notice, setNotice] = useState<Notice | null>(null);
  const [cancelTarget, setCancelTarget] = useState<number | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<PromptVersionItem | null>(null);
  const [compare, setCompare] = useState<{ readonly from: string; readonly to: string } | null>(null);
  const [compareScope, setCompareScope] = useState(scopeValue);
  if (compareScope !== scopeValue) {
    // Browser navigation changes scope without calling changeScope. Neither an
    // applied diff nor an unsubmitted draft may leak into the new scope.
    setCompareScope(scopeValue);
    setCompare(null);
  }
  const file = fileQuery.data;
  const applied = versions.data?.current ?? null;
  const items = versions.data?.items ?? [];
  const pagination = useClientPagination(items, scopeValue);
  const chatItems = chats.data?.items ?? [];
  // The deep-linked chat can be absent while the chat list loads, after it
  // fails, or when the chat is unavailable. Without an option the native
  // select would display "Global prompt" while saving to the group scope.
  const missingChat = chat !== undefined && !chatItems.some((item) => item.id === chat);

  const invalidatePrompts = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['prompt-document'] });
    void queryClient.invalidateQueries({ queryKey: ['prompt-versions'] });
  };
  /** A conflict refetches the moved file; an apply failure still recorded a version. */
  const failWrite = (error: unknown): void => {
    if (error instanceof ApiError && error.code === PROMPT_CONFLICT_CODE) {
      setNotice({ kind: 'conflict' });
      void fileQuery.refetch();
      return;
    }
    if (failedPromptVersion(error) !== null) {
      setNotice({ kind: 'apply_failed', message: errorMessage(error) });
      invalidatePrompts();
      return;
    }
    setNotice({ kind: 'error', message: errorMessage(error) });
  };
  const succeedWrite = (result: PromptSaveResponse): void => {
    if (result.status === 'unchanged') {
      setNotice({ kind: 'unchanged' });
      return;
    }
    setNotice({ kind: 'saved' });
    toast.success(t('pages.prompts.savedToast'));
    invalidatePrompts();
    if (result.affected_running > 0) {
      setCancelTarget(result.affected_running);
    }
  };
  const save = useMutation({
    mutationFn: (draft: PromptDraft) => {
      const note = draft.note.trim();
      return savePrompt(scope, note.length === 0 ? { prompt: draft.text } : { prompt: draft.text, note }, draft.hash);
    },
    onMutate: () => {
      setNotice(null);
    },
    onSuccess: succeedWrite,
    onError: failWrite,
  });
  const restore = useMutation({
    mutationFn: (input: { readonly version: PromptVersionItem; readonly hash: string }) =>
      restorePromptVersion(
        input.version.id,
        { note: t('pages.prompts.restoreNote', { seq: input.version.seq }) },
        input.hash,
      ),
    onMutate: () => {
      setNotice(null);
    },
    onSuccess: (result) => {
      setRestoreTarget(null);
      succeedWrite(result);
    },
    onError: (error) => {
      failWrite(error);
      // Both failures mean the recorded history moved: close the dialog onto
      // the refreshed file view and the failure notice.
      if (error instanceof ApiError && (error.code === PROMPT_CONFLICT_CODE || failedPromptVersion(error) !== null)) {
        setRestoreTarget(null);
      }
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelPromptRunning(scope),
    onSuccess: (result) => {
      setCancelTarget(null);
      toast.success(
        t('pages.prompts.cancelResult', { count: result.canceled_invocations, buckets: result.expired_buckets }),
      );
      void queryClient.invalidateQueries({ queryKey: ['prompt-versions'] });
    },
  });
  const changeScope = (next: { readonly chat: string }): void => {
    query.apply(next);
    setNotice(null);
    setCancelTarget(null);
    setRestoreTarget(null);
    setCompare(null);
  };
  const diffSelection = compare ?? { from: '', to: '' };
  const diff = useQuery({ ...promptDiffQuery(diffSelection.from, diffSelection.to), enabled: compare !== null });
  const columns: readonly ColumnSpec<PromptVersionItem>[] = [
    {
      key: 'version',
      title: t('pages.prompts.colVersion'),
      render: (row) => (
        <span className={css({ display: 'inline-flex', alignItems: 'center', gap: '2' })}>
          <MonoValue value={`v${row.seq}`} />
          {row.id === applied?.id ? <ToneBadge tone="success">{t('pages.prompts.currentBadge')}</ToneBadge> : null}
        </span>
      ),
    },
    {
      key: 'created',
      title: t('pages.prompts.colCreated'),
      render: (row) => (
        <span className={css({ fontVariantNumeric: 'tabular-nums' })}>{formatTime(row.created_at)}</span>
      ),
    },
    {
      key: 'source',
      title: t('pages.prompts.colSource'),
      render: (row) => <ToneBadge tone={sourceTone(row.source)}>{t(sourceLabelKey(row.source))}</ToneBadge>,
    },
    {
      key: 'note',
      title: t('pages.prompts.colNote'),
      render: (row) => <TextValue value={row.note} />,
    },
    {
      key: 'author',
      title: t('pages.prompts.colAuthor'),
      render: (row) => <TextValue value={row.created_by} />,
    },
    {
      key: 'actions',
      title: t('pages.prompts.colActions'),
      align: 'right',
      render: (row) =>
        row.id === applied?.id ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            color="secondary"
            disabled={file === undefined || restore.isPending}
            onClick={() => {
              restore.reset();
              setRestoreTarget(row);
            }}
          >
            {t('pages.prompts.restore')}
          </Button>
        ),
    },
  ];
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('layout.nav.prompts')} />
      <ListSearchForm value={query.value} emptyValue={EMPTY_SCOPE} onSearch={changeScope}>
        {({ draft, change }) => (
          <QuerySelectField
            label={t('pages.prompts.scopeLabel')}
            showAll={false}
            value={chatQuery(draft.chat) === undefined ? GLOBAL_SCOPE_VALUE : `${CHAT_SCOPE_PREFIX}${draft.chat}`}
            onChange={(value) =>
              change({ chat: value === GLOBAL_SCOPE_VALUE ? '' : value.slice(CHAT_SCOPE_PREFIX.length) })
            }
            options={[
              { value: GLOBAL_SCOPE_VALUE, label: t('pages.prompts.globalScope') },
              ...(missingChat ? [{ value: scopeValue, label: t('pages.prompts.chatScope', { id: chat }) }] : []),
              ...chatItems.map((chatItem) => ({
                value: `${CHAT_SCOPE_PREFIX}${chatItem.id}`,
                label:
                  chatItem.title === null
                    ? t('pages.prompts.chatScope', { id: chatItem.id })
                    : t('pages.prompts.chatScopeTitled', { title: chatItem.title, id: chatItem.id }),
              })),
            ]}
          />
        )}
      </ListSearchForm>
      <Panel title={t('pages.prompts.editorTitle')}>
        {fileQuery.isPending ? (
          <Skeleton className={css({ height: '256px', width: '100%', borderRadius: 'xl' })} />
        ) : fileQuery.isError || file === undefined ? (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
            <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
              {errorMessage(fileQuery.error)}
            </p>
            <Button variant="outline" color="secondary" onClick={() => void fileQuery.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <PromptEditor
            // Remount when the applied version moves (save, restore, an
            // external apply picked up on refetch): a restore can return the
            // file to the hash the draft was pinned to, and only a fresh
            // editor reliably re-seeds from the file view.
            key={applied?.id ?? 'no-applied-version'}
            file={file}
            applied={applied}
            notice={notice}
            saving={save.isPending}
            onSave={(draft) => save.mutate(draft)}
          />
        )}
      </Panel>
      <section className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
        <h2 className={css({ textStyle: 'heading-3' })}>{t('pages.prompts.historyTitle')}</h2>
        <ListSearchForm
          key={scopeValue}
          value={compare ?? EMPTY_COMPARE}
          emptyValue={EMPTY_COMPARE}
          activeCount={compare === null ? 0 : 2}
          onSearch={(next) => {
            const valid =
              next.from !== next.to &&
              items.some((item) => item.id === next.from) &&
              items.some((item) => item.id === next.to);
            setCompare(valid ? next : null);
          }}
        >
          {({ draft, change }) => (
            <>
              <QuerySelectField
                label={t('pages.prompts.compareFrom')}
                value={draft.from}
                onChange={(from) => change({ from })}
                options={items.map((item) => ({ value: item.id, label: `v${item.seq}` }))}
              />
              <QuerySelectField
                label={t('pages.prompts.compareTo')}
                value={draft.to}
                onChange={(to) => change({ to })}
                options={items.map((item) => ({ value: item.id, label: `v${item.seq}` }))}
              />
            </>
          )}
        </ListSearchForm>
        <ListToolbar onRefresh={() => void versions.refetch()} refreshing={versions.isRefetching} />
        {versions.isError ? (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
            <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
              {errorMessage(versions.error)}
            </p>
            <Button variant="outline" color="secondary" onClick={() => void versions.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : null}
        {versions.isPending || versions.data !== undefined ? (
          <div>
            <TableShell
              columns={columns}
              data={pagination.items}
              rowKey={(row) => row.id}
              loading={versions.isPending}
              emptyText={t('pages.prompts.emptyVersions')}
            />
            <ListFooter
              count={pagination.total}
              page={pagination.page}
              pageCount={pagination.pageCount}
              onPageChange={pagination.onPageChange}
            >
              {versions.data === undefined ? null : (
                <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                  {t('pages.prompts.retention', { count: versions.data.retained })}
                </span>
              )}
            </ListFooter>
          </div>
        ) : null}
        {compare === null ? null : diff.isPending ? (
          <Skeleton className={css({ height: '160px', width: '100%', borderRadius: 'xl' })} />
        ) : diff.isError || diff.data === undefined ? (
          <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {errorMessage(diff.error)}
          </p>
        ) : diff.data.hunks.length === 0 ? (
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('pages.prompts.noDifferences')}</p>
        ) : (
          <DiffView diff={diff.data} />
        )}
      </section>
      <ConfirmDialog
        open={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open && !cancel.isPending) {
            setCancelTarget(null);
          }
        }}
        title={t('pages.prompts.affectedTitle')}
        description={t('pages.prompts.affectedDescription', { count: cancelTarget ?? 0 })}
        confirmText={t('pages.prompts.affectedConfirm', { count: cancelTarget ?? 0 })}
        cancelText={t('pages.prompts.affectedDismiss')}
        destructive
        pending={cancel.isPending}
        error={cancel.isError ? errorMessage(cancel.error) : null}
        onConfirm={() => cancel.mutate()}
      />
      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open && !restore.isPending) {
            setRestoreTarget(null);
          }
        }}
        title={t('pages.prompts.restoreTitle', { seq: restoreTarget?.seq ?? '' })}
        description={t('pages.prompts.restoreDescription')}
        confirmText={t('pages.prompts.restoreConfirm')}
        cancelText={t('common.cancel')}
        pending={restore.isPending}
        error={restore.isError ? errorMessage(restore.error) : null}
        onConfirm={() => {
          if (restoreTarget !== null && file !== undefined) {
            restore.mutate({ version: restoreTarget, hash: file.content_hash });
          }
        }}
      />
    </div>
  );
}
