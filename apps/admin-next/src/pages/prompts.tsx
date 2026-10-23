import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { type ColumnSpec, ConfirmDialog, MonoValue, TableShell, TextValue, ToneBadge } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { DiffView } from '@/components/prompts/diff-view';
import { type Notice, type PromptDraft, sourceLabelKey, sourceTone } from '@/components/prompts/prompt-draft';
import { PromptEditor } from '@/components/prompts/prompt-editor';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { chatsQuery, promptDiffQuery, promptDocumentQuery, promptVersionsQuery } from '@/lib/queries';
import { useChatScope, useChatScopeSetter } from '@/lib/search-params';
import { ApiError } from '@/lib/api/core.ts';
import { cancelPromptRunning, failedPromptVersion, restorePromptVersion, savePrompt } from '@/lib/api/prompts.ts';
import type { PromptSaveResponse, PromptScopeRef, PromptVersionItem } from '@/lib/api/prompts.ts';

const GLOBAL_SCOPE_VALUE = 'global';
const CHAT_SCOPE_PREFIX = 'chat:';
const PROMPT_CONFLICT_CODE = 'prompt_conflict';

function scopeOfValue(value: string): PromptScopeRef {
  return value.startsWith(CHAT_SCOPE_PREFIX)
    ? { scope: 'group', chat: value.slice(CHAT_SCOPE_PREFIX.length) }
    : { scope: 'global' };
}

export default function PromptsPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const chats = useQuery(chatsQuery);
  const chat = useChatScope();
  const navigate = useNavigate({ from: '/prompts' });
  const setChat = useChatScopeSetter(navigate);
  const scopeValue = chat === undefined ? GLOBAL_SCOPE_VALUE : `${CHAT_SCOPE_PREFIX}${chat}`;
  const scope = scopeOfValue(scopeValue);
  const fileQuery = useQuery(promptDocumentQuery(scope));
  const versions = useQuery(promptVersionsQuery(scope));
  const [notice, setNotice] = useState<Notice | null>(null);
  const [cancelTarget, setCancelTarget] = useState<number | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<PromptVersionItem | null>(null);
  const [compare, setCompare] = useState<{ readonly from: string; readonly to: string } | null>(null);
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const file = fileQuery.data;
  const applied = versions.data?.current ?? null;
  const items = versions.data?.items ?? [];

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
  const changeScope = (value: string): void => {
    setChat(value === GLOBAL_SCOPE_VALUE ? undefined : value.slice(CHAT_SCOPE_PREFIX.length));
    setNotice(null);
    setCancelTarget(null);
    setRestoreTarget(null);
    setCompare(null);
    setFromId(null);
    setToId(null);
  };
  const selectable = (id: string | null, fallback: string | null): string | null =>
    id !== null && items.some((item) => item.id === id) ? id : fallback;
  const fromValue = selectable(fromId, items.at(1)?.id ?? null);
  const toValue = selectable(toId, items.at(0)?.id ?? null);
  const diffSelection = compare ?? { from: '', to: '' };
  const diff = useQuery({ ...promptDiffQuery(diffSelection.from, diffSelection.to), enabled: compare !== null });
  const columns: readonly ColumnSpec<PromptVersionItem>[] = [
    {
      key: 'version',
      title: t('pages.prompts.colVersion'),
      render: (row) => (
        <span className="inline-flex items-center gap-2">
          <MonoValue value={`v${row.seq}`} />
          {row.id === applied?.id ? <ToneBadge tone="success">{t('pages.prompts.currentBadge')}</ToneBadge> : null}
        </span>
      ),
    },
    {
      key: 'created',
      title: t('pages.prompts.colCreated'),
      render: (row) => <span className="tabular-nums">{formatTime(row.created_at)}</span>,
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
    <div className="space-y-6">
      <Panel
        title={t('pages.prompts.editorTitle')}
        action={
          <div className="flex items-center gap-2">
            <Label htmlFor="prompt-scope" className="text-muted-foreground text-xs">
              {t('pages.prompts.scopeLabel')}
            </Label>
            <Select value={scopeValue} onValueChange={changeScope}>
              <SelectTrigger id="prompt-scope" size="sm" className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={GLOBAL_SCOPE_VALUE}>{t('pages.prompts.globalScope')}</SelectItem>
                {(chats.data?.items ?? []).map((chat) => (
                  <SelectItem key={chat.id} value={`${CHAT_SCOPE_PREFIX}${chat.id}`}>
                    {chat.title === null
                      ? t('pages.prompts.chatScope', { id: chat.id })
                      : t('pages.prompts.chatScopeTitled', { title: chat.title, id: chat.id })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      >
        {fileQuery.isPending ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : fileQuery.isError || file === undefined ? (
          <div className="space-y-3">
            <p role="alert" className="text-destructive text-sm break-words">
              {errorMessage(fileQuery.error)}
            </p>
            <Button variant="outline" onClick={() => void fileQuery.refetch()}>
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
      <Panel title={t('pages.prompts.historyTitle')}>
        {versions.isPending ? (
          <Skeleton className="h-40 w-full rounded-xl" />
        ) : versions.isError ? (
          <div className="space-y-3">
            <p role="alert" className="text-destructive text-sm break-words">
              {errorMessage(versions.error)}
            </p>
            <Button variant="outline" onClick={() => void versions.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-2">
                <Label htmlFor="prompt-compare-from" className="text-muted-foreground text-xs">
                  {t('pages.prompts.compareFrom')}
                </Label>
                <Select value={fromValue ?? ''} onValueChange={(value) => setFromId(value)}>
                  <SelectTrigger id="prompt-compare-from" size="sm" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {`v${item.seq}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="prompt-compare-to" className="text-muted-foreground text-xs">
                  {t('pages.prompts.compareTo')}
                </Label>
                <Select value={toValue ?? ''} onValueChange={(value) => setToId(value)}>
                  <SelectTrigger id="prompt-compare-to" size="sm" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {`v${item.seq}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={fromValue === null || toValue === null || fromValue === toValue}
                onClick={() => {
                  if (fromValue !== null && toValue !== null) {
                    setCompare({ from: fromValue, to: toValue });
                  }
                }}
              >
                {t('pages.prompts.compare')}
              </Button>
            </div>
            <TableShell
              columns={columns}
              data={items}
              rowKey={(row) => row.id}
              emptyText={t('pages.prompts.emptyVersions')}
            />
            {versions.data === undefined ? null : (
              <p className="text-muted-foreground text-xs">
                {t('pages.prompts.retention', { count: versions.data.retained })}
              </p>
            )}
            {compare === null ? null : diff.isPending ? (
              <Skeleton className="h-40 w-full rounded-xl" />
            ) : diff.isError || diff.data === undefined ? (
              <p role="alert" className="text-destructive text-sm break-words">
                {errorMessage(diff.error)}
              </p>
            ) : diff.data.hunks.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('pages.prompts.noDifferences')}</p>
            ) : (
              <DiffView diff={diff.data} />
            )}
          </div>
        )}
      </Panel>
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
