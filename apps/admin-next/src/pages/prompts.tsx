import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button, IconButton } from '@tuuject/koi-react/button';
import { SearchIcon } from '@tuuject/koi-react/icons';
import { Skeleton } from '@tuuject/koi-react/skeleton';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  ConfirmDialog,
  ListFooter,
  ListPageHeader,
  ListSearchForm,
  MonoValue,
  QuerySelectField,
  RowActions,
  TableShell,
  TextValue,
  ToneBadge,
  useClientPagination,
} from '@/components/business';
import { RefreshIcon } from '@/components/icons';
import { Panel } from '@/components/layout/panel';
import { DiffView } from '@/components/prompts/diff-view';
import { type Notice, type PromptDraft, sourceLabelKey, sourceTone } from '@/components/prompts/prompt-draft';
import { PromptEditor } from '@/components/prompts/prompt-editor';
import { PromptScopeRail } from '@/components/prompts/prompt-scope-rail';
import { ApiError } from '@/lib/api/core.ts';
import type { PromptSaveResponse, PromptScopeRef, PromptVersionItem } from '@/lib/api/prompts.ts';
import { cancelPromptRunning, failedPromptVersion, restorePromptVersion, savePrompt } from '@/lib/api/prompts.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { chatQuery, useListQuery } from '@/lib/list-query';
import { chatsQuery, promptDiffQuery, promptDocumentQuery, promptVersionsQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';

const GLOBAL_SCOPE_VALUE = 'global';
const CHAT_SCOPE_PREFIX = 'chat:';
const PROMPT_CONFLICT_CODE = 'prompt_conflict';
const EMPTY_SCOPE = { chat: '', search: '' };
const EMPTY_COMPARE = { from: '', to: '' };

function scopeOfValue(value: string): PromptScopeRef {
  return value.startsWith(CHAT_SCOPE_PREFIX)
    ? { scope: 'group', chat: value.slice(CHAT_SCOPE_PREFIX.length) }
    : { scope: 'global' };
}

export default function PromptsPage(): ReactElement {
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
  // Each confirmation keeps `open` apart from its target, so closing never blanks the text mid-fade.
  const [cancelTarget, setCancelTarget] = useState<number | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<PromptVersionItem | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [compare, setCompare] = useState<{ readonly from: string; readonly to: string } | null>(null);
  const [compareScope, setCompareScope] = useState(scopeValue);
  if (compareScope !== scopeValue) {
    // Browser navigation changes scope without calling changeScope. Neither an
    // applied diff nor an unsubmitted draft may leak into the new scope, and a
    // confirmation opened for the old scope must not act on the new one: its
    // cancel would stop the runs of every Chat instead of the one it named.
    setCompareScope(scopeValue);
    setCompare(null);
    setCancelOpen(false);
    setRestoreOpen(false);
  }
  const file = fileQuery.data;
  const applied = versions.data?.current ?? null;
  const items = versions.data?.items ?? [];
  const pagination = useClientPagination(items, scopeValue);
  const chatItems = chats.data?.items ?? [];
  const selectedChat = chat === undefined ? null : (chatItems.find((item) => item.id === chat) ?? null);
  const scopeTitle =
    chat === undefined
      ? t('pages.prompts.globalScope')
      : (selectedChat?.title ?? t('pages.prompts.chatScope', { id: chat }));

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
      setCancelOpen(true);
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
      setRestoreOpen(false);
      succeedWrite(result);
    },
    onError: (error) => {
      failWrite(error);
      // Both failures mean the recorded history moved: close the dialog onto
      // the refreshed file view and the failure notice.
      if (error instanceof ApiError && (error.code === PROMPT_CONFLICT_CODE || failedPromptVersion(error) !== null)) {
        setRestoreOpen(false);
      }
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelPromptRunning(scope),
    onSuccess: (result) => {
      setCancelOpen(false);
      toast.success(
        t('pages.prompts.cancelResult', { count: result.canceled_invocations, buckets: result.expired_buckets }),
      );
      void queryClient.invalidateQueries({ queryKey: ['prompt-versions'] });
    },
  });
  const changeScope = (next: { readonly chat: string }): void => {
    // The rail's search is a view filter, not part of the scope; switching
    // scopes keeps it so the next list is already narrowed.
    query.apply({ chat: next.chat, search: query.value.search });
    setNotice(null);
    setCancelOpen(false);
    setRestoreOpen(false);
    setCompare(null);
  };
  const diffSelection = compare ?? { from: '', to: '' };
  const diff = useQuery({ ...promptDiffQuery(diffSelection.from, diffSelection.to), enabled: compare !== null });
  const columns: readonly ColumnSpec<PromptVersionItem>[] = [
    {
      key: 'version',
      title: t('pages.prompts.colVersion'),
      width: 136,
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
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (row) => formatTime(row.created_at),
    },
    {
      key: 'source',
      title: t('pages.prompts.colSource'),
      width: 112,
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
      width: 104,
      render: (row) =>
        row.id === applied?.id ? null : (
          <RowActions>
            <Button
              size="sm"
              variant="ghost"
              color="secondary"
              disabled={file === undefined || restore.isPending}
              onClick={() => {
                restore.reset();
                setRestoreTarget(row);
                setRestoreOpen(true);
              }}
            >
              {t('pages.prompts.restore')}
            </Button>
          </RowActions>
        ),
    },
  ];
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '6' } })}>
      <ListPageHeader title={t('layout.nav.prompts')} />
      {chats.isError ? (
        <Alert
          tone="error"
          action={
            <Button size="sm" variant="ghost" color="secondary" onClick={() => void chats.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {errorMessage(chats.error)}
        </Alert>
      ) : null}

      {/* Master and detail split by one hairline (above the detail when stacked, beside it when wide), as on the Providers page. */}
      <div
        className={css({
          display: 'grid',
          gap: '6',
          alignItems: 'start',
          // 332px = the rail's 308px plus its 24px gutter to the hairline.
          '@media (min-width: 1200px)': { gridTemplateColumns: '332px minmax(0, 1fr)', columnGap: '0' },
        })}
      >
        <aside
          className={css({
            minWidth: '0',
            alignSelf: 'start',
            '@media (min-width: 1200px)': {
              paddingInlineEnd: '6',
              position: 'sticky',
              // The same air under the header and above the window edge; past that the rail's list scrolls on its own.
              top: 'calc(var(--app-header-offset) + token(spacing.6))',
              maxHeight: 'calc(100dvh - var(--app-header-offset) - token(spacing.6) * 2)',
              display: 'flex',
              flexDirection: 'column',
            },
          })}
        >
          <PromptScopeRail
            chats={chatItems}
            selectedChat={chat ?? null}
            search={query.value.search}
            onSearch={(next) => query.apply({ chat: query.value.chat, search: next })}
            onSelect={(chatId) => changeScope({ chat: chatId ?? '' })}
            onRefresh={() => void chats.refetch()}
            refreshing={chats.isRefetching}
            loading={chats.isPending}
          />
        </aside>

        <div
          key={scopeValue}
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '6',
            minWidth: '0',
            paddingBlockStart: '6',
            borderTopWidth: '1px',
            borderColor: 'divider',
            '@media (min-width: 1200px)': {
              // Stretch so the hairline runs the full height even when the rail is the taller column.
              alignSelf: 'stretch',
              paddingBlockStart: '0',
              paddingInlineStart: '6',
              borderTopWidth: '0',
              borderInlineStartWidth: '1px',
            },
          })}
        >
          <Panel variant="plain" title={scopeTitle}>
            {fileQuery.isPending ? (
              <Skeleton className={css({ height: '256px', width: '100%', borderRadius: 'xl' })} />
            ) : fileQuery.isError || file === undefined ? (
              <Alert
                tone="error"
                action={
                  <Button size="sm" variant="ghost" color="secondary" onClick={() => void fileQuery.refetch()}>
                    {t('common.retry')}
                  </Button>
                }
              >
                {errorMessage(fileQuery.error)}
              </Alert>
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
          <Panel
            variant="plain"
            className={css({ borderTopWidth: '1px', borderColor: 'divider', paddingBlockStart: '6' })}
            title={t('pages.prompts.historyTitle')}
            action={
              <IconButton
                variant="ghost"
                color="secondary"
                label={t('layout.business.refreshList')}
                icon={<RefreshIcon />}
                disabled={versions.isRefetching}
                onClick={() => void versions.refetch()}
              />
            }
          >
            <div className={css({ display: 'flex', flexDirection: 'column', gap: '6' })}>
              <ListSearchForm
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
                renderSubmitAndResetButton={() => (
                  <Button type="submit" iconStart={<SearchIcon />}>
                    {t('pages.prompts.compare')}
                  </Button>
                )}
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
              {versions.isError ? (
                <Alert
                  tone="error"
                  action={
                    <Button size="sm" variant="ghost" color="secondary" onClick={() => void versions.refetch()}>
                      {t('common.retry')}
                    </Button>
                  }
                >
                  {errorMessage(versions.error)}
                </Alert>
              ) : null}
              {versions.isPending || versions.data !== undefined ? (
                <div>
                  <TableShell
                    columns={columns}
                    data={pagination.items}
                    rowKey={(row) => row.id}
                    loading={versions.isPending}
                    minWidth={880}
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
                <Alert tone="error">{errorMessage(diff.error)}</Alert>
              ) : diff.data.hunks.length === 0 ? (
                <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('pages.prompts.noDifferences')}</p>
              ) : (
                <DiffView diff={diff.data} />
              )}
            </div>
          </Panel>
        </div>
      </div>
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={(open) => {
          if (!open && !cancel.isPending) {
            setCancelOpen(false);
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
        open={restoreOpen}
        onOpenChange={(open) => {
          if (!open && !restore.isPending) {
            setRestoreOpen(false);
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
