import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button, IconButton } from '@tuuject/koi-react/button';
import { PlusIcon, TrashIcon } from '@tuuject/koi-react/icons';
import { Skeleton } from '@tuuject/koi-react/skeleton';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ConfirmDialog,
  type ColumnSpec,
  ListFooter,
  ListPageHeader,
  ListSearchForm,
  ListToolbar,
  MonoValue,
  QueryTextField,
  RowActions,
  TableShell,
  ToneBadge,
  useClientPagination,
} from '@/components/business';
import { EditIcon, EyeIcon } from '@/components/icons';
import { ServerDetailDialog } from '@/components/mcp-servers/server-detail-dialog.tsx';
import { ServerDialog, type ServerDialogTarget } from '@/components/mcp-servers/server-dialog.tsx';
import { deleteMcpServer, type McpServerView, type McpServersView } from '@/lib/api/mcp-servers.ts';
import { errorMessage } from '@/lib/errors';
import { useListQuery } from '@/lib/list-query';
import { useProviderWrite } from '@/lib/use-provider-write';
import { isConfigConflict } from '@/lib/model-manager';
import { configStatusQuery, mcpServersQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';

const EMPTY_FILTERS = { search: '' };

function LiveStateBadge({ server }: { readonly server: McpServerView }): ReactElement {
  const { t } = useTranslation();
  if (server.state === null) {
    return <ToneBadge tone="neutral">{t('mcp.stateUnknown')}</ToneBadge>;
  }
  if (server.state.state === 'ready') {
    return <ToneBadge tone="success">{t('mcp.stateReady')}</ToneBadge>;
  }
  if (server.state.state === 'connecting') {
    return <ToneBadge tone="info">{t('mcp.stateConnecting')}</ToneBadge>;
  }
  return (
    <ToneBadge tone="warning">
      {t('mcp.stateDegraded')}
      {server.state.error_code === null ? '' : `: ${server.state.error_code}`}
    </ToneBadge>
  );
}

/** The MCP servers the bot itself connects to, with live state and per-Chat usage. */
export default function McpServersPage(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery(mcpServersQuery);
  const listQuery = useListQuery(EMPTY_FILTERS);
  const search = listQuery.value.search;
  // Dialogs stay mounted so their exit transitions play; `nonce` remounts forms per open.
  const [editing, setEditing] = useState<ServerDialogTarget | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorNonce, setEditorNonce] = useState(0);
  const [inspecting, setInspecting] = useState<McpServerView | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [removing, setRemoving] = useState<{ readonly server: McpServerView; readonly revision: string } | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const write = useProviderWrite();
  const remove = useMutation({
    mutationFn: (target: { readonly server: McpServerView; readonly revision: string }) =>
      deleteMcpServer(target.server.alias, target.revision),
    onSuccess: (result) => {
      setRemoveOpen(false);
      void refresh();
      // The apply outcome is part of the answer, like every other config write.
      write.succeeded(result.apply);
    },
    onError: (error) => {
      void refresh();
      write.failed(error);
      if (isConfigConflict(error)) {
        setRemoveOpen(false);
        toast.error(t('mcp.conflictBody'));
      }
    },
  });
  const visible = (query.data?.servers ?? []).filter((server) => {
    if (search.length === 0) {
      return true;
    }
    const needle = search.toLowerCase();
    return (
      server.alias.toLowerCase().includes(needle) ||
      server.bound_chats.some((chat) => chat.chat_id.includes(needle)) ||
      (server.connection.kind === 'streamable_http' && server.connection.url.toLowerCase().includes(needle))
    );
  });
  const pagination = useClientPagination(visible, listQuery.resetKey);

  const refresh = (): Promise<void> => {
    void queryClient.invalidateQueries({ queryKey: mcpServersQuery.queryKey });
    void queryClient.invalidateQueries({ queryKey: configStatusQuery.queryKey });
    return Promise.resolve();
  };

  const openEditor = (server: McpServerView | null): void => {
    const view = query.data;
    if (view === undefined) {
      return;
    }
    setEditing({ view, server });
    setEditorNonce((nonce) => nonce + 1);
    setEditorOpen(true);
  };

  const columns: readonly ColumnSpec<McpServerView>[] = [
    {
      key: 'alias',
      title: t('mcp.colServer'),
      width: 200,
      render: (server) => (
        <div>
          <MonoValue value={server.alias} />
          <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>
            {server.transport === 'stdio' ? 'stdio' : 'streamable_http'}
          </p>
        </div>
      ),
    },
    {
      key: 'state',
      title: t('mcp.colState'),
      width: 170,
      render: (server) => <LiveStateBadge server={server} />,
    },
    {
      key: 'tools',
      title: t('mcp.colTools'),
      width: 170,
      render: (server) =>
        server.tools === '*' ? (
          t('mcp.toolsAll')
        ) : (
          <span className={css({ whiteSpace: 'normal' })}>{server.tools.join(', ')}</span>
        ),
    },
    {
      key: 'usage',
      title: t('mcp.colUsage'),
      className: css({ whiteSpace: 'normal' }),
      render: (server) =>
        server.bound_chats.length === 0 ? (
          t('mcp.inheritedOnly')
        ) : (
          <span>{t('mcp.boundChats', { chats: server.bound_chats.map((chat) => chat.chat_id).join(', ') })}</span>
        ),
    },
    {
      key: 'actions',
      title: t('pages.apiKeys.actions'),
      align: 'right',
      width: 140,
      paddingBlock: 'none',
      render: (server) => (
        <RowActions>
          <IconButton
            variant="ghost"
            color="secondary"
            disabled={remove.isPending}
            onClick={() => {
              setInspecting(server);
              setDetailOpen(true);
            }}
            label={`${t('common.view')} ${server.alias}`}
            icon={<EyeIcon />}
          />
          <IconButton
            variant="ghost"
            color="secondary"
            disabled={remove.isPending}
            onClick={() => openEditor(server)}
            label={`${t('common.edit')} ${server.alias}`}
            icon={<EditIcon />}
          />
          <IconButton
            variant="ghost"
            color="error"
            disabled={remove.isPending}
            onClick={() => {
              remove.reset();
              setRemoving({ server, revision: query.data?.revision ?? '' });
              setRemoveOpen(true);
            }}
            label={`${t('common.delete')} ${server.alias}`}
            icon={<TrashIcon />}
          />
        </RowActions>
      ),
    },
  ];

  if (query.isPending) {
    return (
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
        <ListPageHeader title={t('mcp.title')} />
        <Skeleton className={css({ height: '256px', width: '100%' })} />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
        <ListPageHeader title={t('mcp.title')} />
        <Alert
          tone="error"
          action={
            <Button size="sm" variant="ghost" color="secondary" onClick={() => void query.refetch()}>
              {t('common.reload')}
            </Button>
          }
        >
          {errorMessage(query.error)}
        </Alert>
      </div>
    );
  }
  const view: McpServersView = query.data;
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('mcp.title')} description={t('mcp.titleHint')} />
      <ListSearchForm value={listQuery.value} emptyValue={EMPTY_FILTERS} onSearch={listQuery.apply}>
        {({ draft, change }) => (
          <QueryTextField label={t('mcp.colServer')} value={draft.search} onChange={(search) => change({ search })} />
        )}
      </ListSearchForm>
      <ListToolbar onRefresh={() => void query.refetch()} refreshing={query.isRefetching}>
        <Button variant="outline" iconStart={<PlusIcon />} onClick={() => openEditor(null)}>
          {t('mcp.addServer')}
        </Button>
      </ListToolbar>
      <div>
        <TableShell
          columns={columns}
          data={pagination.items}
          rowKey={(server) => server.alias}
          minWidth={880}
          emptyText={t('mcp.empty')}
        />
        <ListFooter
          count={pagination.total}
          page={pagination.page}
          pageCount={pagination.pageCount}
          onPageChange={pagination.onPageChange}
        />
      </div>
      {view.unbound_chat_ids.length > 0 ? (
        <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>
          {t('mcp.unboundChats', { chats: view.unbound_chat_ids.join(', ') })}
        </p>
      ) : null}
      <ServerDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        target={editing}
        formKey={editorNonce}
        onWritten={() => void refresh()}
      />
      <ServerDetailDialog open={detailOpen} onOpenChange={setDetailOpen} server={inspecting} />
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setRemoveOpen(false);
          }
        }}
        title={t('mcp.removeTitle', { alias: removing?.server.alias ?? '' })}
        description={t('mcp.removeDescription')}
        confirmText={t('common.delete')}
        destructive
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => {
          if (removing !== null) {
            remove.mutate(removing);
          }
        }}
      />
    </div>
  );
}
