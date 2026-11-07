import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Select } from '@tuuject/koi-react/select';
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
  QueryTextField,
  TableShell,
  ToneBadge,
  useClientPagination,
} from '@/components/business';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { AdminApiKeyItem, ApiKeyMode } from '@/lib/api/admin.ts';
import { createApiKey, revokeApiKey, rotateApiKey, updateApiKeyMode } from '@/lib/api/admin.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { useListQuery } from '@/lib/list-query';
import { apiKeysQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';

const MODES: readonly ApiKeyMode[] = ['read', 'read_write', 'read_paid', 'all'];
const EMPTY_FILTERS = { search: '' };

function ModeSelect({
  id,
  value,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly value: ApiKeyMode;
  readonly disabled?: boolean;
  readonly onChange: (mode: ApiKeyMode) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Select
      id={id}
      className="w-full"
      value={value}
      disabled={disabled ?? false}
      onChange={(event) => {
        const selected = MODES.find((candidate) => candidate === event.target.value);
        if (selected !== undefined) {
          onChange(selected);
        }
      }}
    >
      {MODES.map((mode) => (
        <option key={mode} value={mode}>
          {t(`pages.apiKeys.modes.${mode}`)}
        </option>
      ))}
    </Select>
  );
}

function ModeBadge({ item }: { readonly item: AdminApiKeyItem }): React.ReactElement {
  const { t } = useTranslation();
  const mode = MODES.find((candidate) => candidate === item.mode);
  if (mode === undefined) {
    return <ToneBadge tone="danger">{t('pages.apiKeys.invalidPermissions')}</ToneBadge>;
  }
  return <ToneBadge tone={mode === 'read' ? 'neutral' : 'success'}>{t(`pages.apiKeys.modes.${mode}`)}</ToneBadge>;
}

export default function ApiKeysPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const keys = useQuery(apiKeysQuery);
  const query = useListQuery(EMPTY_FILTERS);
  const search = query.value.search;
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminApiKeyItem | null>(null);
  const [rotating, setRotating] = useState<AdminApiKeyItem | null>(null);
  const [revoking, setRevoking] = useState<AdminApiKeyItem | null>(null);
  const revoke = useMutation({
    mutationFn: revokeApiKey,
    retry: false,
    onSuccess: () => {
      setRevoking(null);
      toast.success(t('pages.apiKeys.revokedMessage'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
    },
  });
  const filteredKeys = (keys.data?.items ?? []).filter((item) => {
    if (search.length === 0) {
      return true;
    }
    const needle = search.toLowerCase();
    return item.name.toLowerCase().includes(needle) || item.prefix.toLowerCase().includes(needle);
  });
  const pagination = useClientPagination(filteredKeys, query.resetKey);
  const columns: readonly ColumnSpec<AdminApiKeyItem>[] = [
    {
      key: 'name',
      title: t('pages.apiKeys.name'),
      className: 'max-w-52 whitespace-normal [overflow-wrap:anywhere]',
      render: (item) => item.name,
    },
    {
      key: 'prefix',
      title: t('pages.apiKeys.prefix'),
      render: (item) => <MonoValue value={`${item.prefix}…`} />,
    },
    {
      key: 'mode',
      title: t('pages.apiKeys.mode'),
      render: (item) => <ModeBadge item={item} />,
    },
    { key: 'created', title: t('pages.apiKeys.created'), render: (item) => formatTime(item.created_at) },
    {
      key: 'last-used',
      title: t('pages.apiKeys.lastUsed'),
      render: (item) => (item.last_used_at === null ? t('pages.apiKeys.neverUsed') : formatTime(item.last_used_at)),
    },
    {
      key: 'status',
      title: t('pages.apiKeys.status'),
      render: (item) => (
        <div className="space-y-1">
          <ToneBadge tone={item.revoked_at === null ? 'success' : 'neutral'}>
            {item.revoked_at === null ? t('pages.apiKeys.active') : t('pages.apiKeys.revoked')}
          </ToneBadge>
          {item.revoked_at === null ? null : (
            <p className="text-muted-foreground text-xs">{formatTime(item.revoked_at)}</p>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      title: t('pages.apiKeys.actions'),
      render: (item) =>
        item.revoked_at === null ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(item)}>
              {t('pages.apiKeys.editMode')}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setRotating(item)}>
              {t('pages.apiKeys.rotate')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() => {
                revoke.reset();
                setRevoking(item);
              }}
            >
              {t('pages.apiKeys.revoke')}
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="min-w-0 space-y-5">
      <ListPageHeader title={t('pages.apiKeys.title')} description={t('pages.apiKeys.description')} />
      <ListSearchForm value={query.value} emptyValue={EMPTY_FILTERS} onSearch={query.apply}>
        {({ draft, change }) => (
          <QueryTextField
            label={t('pages.apiKeys.name')}
            value={draft.search}
            onChange={(search) => change({ search })}
          />
        )}
      </ListSearchForm>
      <ListToolbar onRefresh={() => void keys.refetch()} refreshing={keys.isRefetching}>
        <Button type="button" onClick={() => setCreating(true)}>
          {t('pages.apiKeys.create')}
        </Button>
      </ListToolbar>
      {keys.isError ? (
        <div className="space-y-2">
          <p role="alert" className="text-destructive text-sm break-words">
            {errorMessage(keys.error)}
          </p>
          <Button type="button" variant="outline" disabled={keys.isFetching} onClick={() => void keys.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : null}
      {keys.isPending || keys.data !== undefined ? (
        <div>
          <TableShell
            columns={columns}
            data={pagination.items}
            rowKey={(item) => item.id}
            loading={keys.isPending}
            frame={false}
            emptyText={search.length === 0 ? t('pages.apiKeys.empty') : t('layout.koi.noMatches')}
          />
          {keys.data === undefined ? null : (
            <ListFooter
              count={pagination.total}
              page={pagination.page}
              pageCount={pagination.pageCount}
              onPageChange={pagination.onPageChange}
            />
          )}
        </div>
      ) : null}
      {creating ? <CreateKeyDialog onClose={() => setCreating(false)} /> : null}
      {editing !== null ? <EditModeDialog item={editing} onClose={() => setEditing(null)} /> : null}
      {rotating !== null ? <RotateKeyDialog item={rotating} onClose={() => setRotating(null)} /> : null}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !revoke.isPending) {
            setRevoking(null);
          }
        }}
        title={t('pages.apiKeys.revokeTitle')}
        description={
          <span className="[overflow-wrap:anywhere]">
            {t('pages.apiKeys.revokeDescription', { name: revoking?.name ?? '' })}
          </span>
        }
        confirmText={t('pages.apiKeys.revokeConfirm')}
        cancelText={t('common.cancel')}
        destructive
        pending={revoke.isPending}
        error={revoke.isError ? errorMessage(revoke.error) : null}
        onConfirm={() => {
          if (revoking !== null && !revoke.isPending) {
            revoke.mutate(revoking.id);
          }
        }}
      />
    </div>
  );
}

function CreateKeyDialog({ onClose }: { readonly onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ApiKeyMode>('read');
  const [nameError, setNameError] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'pending' | 'copied' | 'failed'>('idle');
  const create = useMutation({
    // Return nothing: mutation/query caches must never retain the one-time key.
    // Closing this dialog unmounts its local state, rather than hiding the key.
    mutationFn: async (input: { readonly name: string; readonly mode: ApiKeyMode }): Promise<void> => {
      const result = await createApiKey(input.name, input.mode);
      setPlaintext(result.key);
    },
    gcTime: 0,
    retry: false,
    onSettled: () => {
      // A lost create response can still have issued a key; refresh metadata so it can be revoked.
      void queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DialogContent className="min-w-0 max-h-[calc(100dvh-2rem)] overflow-y-auto" showCloseButton={!create.isPending}>
        <DialogHeader>
          <DialogTitle>{plaintext === null ? t('pages.apiKeys.create') : t('pages.apiKeys.saveTitle')}</DialogTitle>
          <DialogDescription>
            {plaintext === null ? t('pages.apiKeys.createDescription') : t('pages.apiKeys.saveDescription')}
          </DialogDescription>
        </DialogHeader>
        {plaintext === null ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (create.isPending) {
                return;
              }
              const trimmed = name.trim();
              if (trimmed.length === 0 || trimmed.length > 80) {
                setNameError(true);
                return;
              }
              setNameError(false);
              create.mutate({ name: trimmed, mode });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="api-key-name">{t('pages.apiKeys.name')}</Label>
              <Input
                id="api-key-name"
                value={name}
                maxLength={80}
                autoComplete="off"
                placeholder={t('pages.apiKeys.namePlaceholder')}
                disabled={create.isPending}
                aria-invalid={nameError}
                aria-describedby={nameError ? 'api-key-name-error' : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(false);
                }}
              />
              {nameError ? (
                <p id="api-key-name-error" role="alert" className="text-destructive text-sm">
                  {t('pages.apiKeys.invalidName')}
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="api-key-mode">{t('pages.apiKeys.mode')}</Label>
              <ModeSelect id="api-key-mode" value={mode} disabled={create.isPending} onChange={setMode} />
              <p className="text-muted-foreground text-xs">{t(`pages.apiKeys.modeHints.${mode}`)}</p>
            </div>
            {create.isError ? (
              <p role="alert" className="text-destructive text-sm break-words">
                {errorMessage(create.error)}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={create.isPending} onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? t('pages.apiKeys.creating') : t('pages.apiKeys.createConfirm')}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <KeyReveal plaintext={plaintext} copyState={copyState} setCopyState={setCopyState} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditModeDialog({
  item,
  onClose,
}: {
  readonly item: AdminApiKeyItem;
  readonly onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ApiKeyMode>(item.mode ?? 'read');
  const update = useMutation({
    mutationFn: (next: ApiKeyMode) => updateApiKeyMode(item.id, next),
    retry: false,
    onSuccess: () => {
      toast.success(t('pages.apiKeys.modeUpdated'));
      onClose();
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !update.isPending && onClose()}>
      <DialogContent className="min-w-0">
        <DialogHeader>
          <DialogTitle>{t('pages.apiKeys.editMode')}</DialogTitle>
          <DialogDescription>{t('pages.apiKeys.editModeDescription', { name: item.name })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="api-key-edit-mode">{t('pages.apiKeys.mode')}</Label>
          <ModeSelect id="api-key-edit-mode" value={mode} disabled={update.isPending} onChange={setMode} />
          <p className="text-muted-foreground text-xs">{t(`pages.apiKeys.modeHints.${mode}`)}</p>
          {item.mode === null ? (
            <p role="alert" className="text-destructive text-sm">
              {t('pages.apiKeys.invalidPermissionsHint')}
            </p>
          ) : null}
          {update.isError ? (
            <p role="alert" className="text-destructive text-sm break-words">
              {errorMessage(update.error)}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={update.isPending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="button" disabled={update.isPending} onClick={() => update.mutate(mode)}>
            {update.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RotateKeyDialog({
  item,
  onClose,
}: {
  readonly item: AdminApiKeyItem;
  readonly onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'pending' | 'copied' | 'failed'>('idle');
  const rotate = useMutation({
    mutationFn: async (): Promise<void> => {
      const result = await rotateApiKey(item.id);
      setPlaintext(result.key);
    },
    gcTime: 0,
    retry: false,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !rotate.isPending && onClose()}>
      <DialogContent className="min-w-0 max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {plaintext === null ? t('pages.apiKeys.rotateTitle') : t('pages.apiKeys.saveTitle')}
          </DialogTitle>
          <DialogDescription>
            {plaintext === null
              ? t('pages.apiKeys.rotateDescription', { name: item.name })
              : t('pages.apiKeys.saveDescription')}
          </DialogDescription>
        </DialogHeader>
        {plaintext === null ? (
          <>
            {rotate.isError ? (
              <p role="alert" className="text-destructive text-sm break-words">
                {errorMessage(rotate.error)}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={rotate.isPending} onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="button" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
                {rotate.isPending ? t('common.saving') : t('pages.apiKeys.rotateConfirm')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <KeyReveal plaintext={plaintext} copyState={copyState} setCopyState={setCopyState} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function KeyReveal({
  plaintext,
  copyState,
  setCopyState,
  onClose,
}: {
  readonly plaintext: string;
  readonly copyState: 'idle' | 'pending' | 'copied' | 'failed';
  readonly setCopyState: (state: 'idle' | 'pending' | 'copied' | 'failed') => void;
  readonly onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <div className="min-w-0 space-y-2">
        <Label htmlFor="api-key-plaintext">{t('pages.apiKeys.keyLabel')}</Label>
        <Textarea
          id="api-key-plaintext"
          value={plaintext}
          readOnly
          autoComplete="off"
          spellCheck={false}
          className="resize-none break-all font-mono"
          onFocus={(event) => event.target.select()}
        />
        {copyState === 'failed' ? (
          <p role="alert" className="text-destructive text-sm">
            {t('pages.apiKeys.copyFailed')}
          </p>
        ) : copyState === 'copied' ? (
          <p role="status" className="text-success text-sm">
            {t('common.copied')}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={copyState === 'pending'}
          onClick={async () => {
            setCopyState('pending');
            try {
              await navigator.clipboard.writeText(plaintext);
              setCopyState('copied');
            } catch {
              setCopyState('failed');
            }
          }}
        >
          {t('pages.apiKeys.copy')}
        </Button>
        <Button type="button" onClick={onClose}>
          {t('pages.apiKeys.done')}
        </Button>
      </DialogFooter>
    </>
  );
}
