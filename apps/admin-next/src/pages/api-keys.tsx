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
  RowActions,
  QueryTextField,
  TableShell,
  ToneBadge,
  useClientPagination,
} from '@/components/business';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { PlusIcon } from '@tuuject/koi-react/icons';
import type { AdminApiKeyItem } from '@/lib/api/admin.ts';
import { revokeApiKey } from '@/lib/api/admin.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { useListQuery } from '@/lib/list-query';
import { apiKeysQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';
import { css } from '@tuuject/koi-react/styled-system/css';
import { CreateKeyDialog, EditModeDialog, MODES, RotateKeyDialog } from './api-keys-dialogs.tsx';

const EMPTY_FILTERS = { search: '' };

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
    { key: 'name', title: t('pages.apiKeys.name'), render: (item) => item.name },
    {
      key: 'prefix',
      title: t('pages.apiKeys.prefix'),
      width: 168,
      skeleton: 'pwk_xxxxxxxx…',
      render: (item) => <MonoValue value={`${item.prefix}…`} />,
    },
    {
      key: 'mode',
      title: t('pages.apiKeys.mode'),
      width: 132,
      render: (item) => <ModeBadge item={item} />,
    },
    {
      key: 'created',
      title: t('pages.apiKeys.created'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (item) => formatTime(item.created_at),
    },
    {
      key: 'last-used',
      title: t('pages.apiKeys.lastUsed'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (item) => (item.last_used_at === null ? t('pages.apiKeys.neverUsed') : formatTime(item.last_used_at)),
    },
    {
      key: 'status',
      title: t('pages.apiKeys.status'),
      width: 112,
      render: (item) => (
        <ToneBadge tone={item.revoked_at === null ? 'success' : 'neutral'}>
          {item.revoked_at === null ? t('pages.apiKeys.active') : t('pages.apiKeys.revoked')}
        </ToneBadge>
      ),
    },
    {
      key: 'actions',
      title: t('pages.apiKeys.actions'),
      align: 'right',
      width: 248,
      render: (item) =>
        item.revoked_at === null ? (
          <RowActions>
            <Button size="sm" variant="ghost" color="secondary" onClick={() => setEditing(item)}>
              {t('pages.apiKeys.editMode')}
            </Button>
            <Button size="sm" variant="ghost" color="secondary" onClick={() => setRotating(item)}>
              {t('pages.apiKeys.rotate')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              color="error"
              disabled={revoke.isPending}
              onClick={() => {
                revoke.reset();
                setRevoking(item);
              }}
            >
              {t('pages.apiKeys.revoke')}
            </Button>
          </RowActions>
        ) : (
          <span className={css({ color: 'text-muted' })}>{formatTime(item.revoked_at)}</span>
        ),
    },
  ];

  return (
    <div className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
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
        <Button variant="outline" iconStart={<PlusIcon />} onClick={() => setCreating(true)}>
          {t('pages.apiKeys.create')}
        </Button>
      </ListToolbar>
      {keys.isError ? (
        <Alert
          tone="error"
          action={
            <Button
              size="sm"
              variant="ghost"
              color="secondary"
              loading={keys.isFetching}
              onClick={() => void keys.refetch()}
            >
              {t('common.retry')}
            </Button>
          }
        >
          {errorMessage(keys.error)}
        </Alert>
      ) : null}
      {keys.isPending || keys.data !== undefined ? (
        <div>
          <TableShell
            columns={columns}
            data={pagination.items}
            rowKey={(item) => item.id}
            loading={keys.isPending}
            minWidth={1040}
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
          <span className={css({ overflowWrap: 'anywhere' })}>
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
