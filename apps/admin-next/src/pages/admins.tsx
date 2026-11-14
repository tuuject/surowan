import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { PlusIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useState } from 'react';
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
  RowActions,
  TableShell,
  useClientPagination,
} from '@/components/business';
import type { BotAdminEntry } from '@/lib/api/admin.ts';
import { addBotAdmin, removeBotAdmin } from '@/lib/api/admin.ts';
import { errorMessage } from '@/lib/errors';
import { useListQuery } from '@/lib/list-query';
import { adminsQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';

const ADMIN_ID_PATTERN = /^\d{1,15}$/;
const EMPTY_FILTERS = { search: '' };

export default function AdminsPage(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useListQuery(EMPTY_FILTERS);
  const search = query.value.search;
  const [addOpen, setAddOpen] = useState(false);
  const [userIdDraft, setUserIdDraft] = useState('');
  const [userIdError, setUserIdError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<BotAdminEntry | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  const admins = useQuery(adminsQuery);

  const add = useMutation({
    mutationFn: (userId: number) => addBotAdmin({ telegram_user_id: userId }, admins.data?.revision ?? ''),
    onSuccess: (view) => {
      setAddOpen(false);
      toast.success(t('pages.admins.adminAdded'));
      // The response carries the fresh list and revision; skip a refetch.
      queryClient.setQueryData(adminsQuery.queryKey, view);
    },
    onError: () => {
      // Dialog stays open; the inline error shows why and the input is kept.
      void queryClient.invalidateQueries({ queryKey: ['admins'] });
    },
  });

  const remove = useMutation({
    mutationFn: (entry: BotAdminEntry) => removeBotAdmin(entry.telegram_user_id, admins.data?.revision ?? ''),
    onSuccess: (view) => {
      setRemoveOpen(false);
      toast.success(t('pages.admins.adminRemoved'));
      queryClient.setQueryData(adminsQuery.queryKey, view);
    },
    onError: () => {
      // The list refreshes so a row removed elsewhere disappears.
      void queryClient.invalidateQueries({ queryKey: ['admins'] });
    },
  });

  const columns: readonly ColumnSpec<BotAdminEntry>[] = [
    {
      key: 'telegram_user_id',
      title: t('pages.admins.colTelegramUserId'),
      render: (row) => <MonoValue value={row.telegram_user_id} />,
    },
    {
      key: 'actions',
      title: t('pages.admins.colActions'),
      align: 'right',
      width: 104,
      render: (row) => (
        <RowActions>
          <Button
            size="sm"
            variant="ghost"
            color="error"
            onClick={() => {
              remove.reset();
              setRemoving(row);
              setRemoveOpen(true);
            }}
          >
            {t('pages.admins.remove')}
          </Button>
        </RowActions>
      ),
    },
  ];

  const filteredAdmins = (admins.data?.items ?? []).filter((entry) =>
    search.length === 0 ? true : entry.telegram_user_id.includes(search),
  );
  const pagination = useClientPagination(filteredAdmins, query.resetKey);

  const submitAdd = (): void => {
    const trimmed = userIdDraft.trim();
    if (!ADMIN_ID_PATTERN.test(trimmed)) {
      setUserIdError(t('pages.admins.invalidUserId'));
      return;
    }
    setUserIdError(null);
    add.mutate(Number(trimmed));
  };

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('layout.nav.botAdmins')} />
      <ListSearchForm value={query.value} emptyValue={EMPTY_FILTERS} onSearch={query.apply}>
        {({ draft, change }) => (
          <QueryTextField
            label={t('pages.admins.userIdLabel')}
            value={draft.search}
            onChange={(search) => change({ search })}
          />
        )}
      </ListSearchForm>

      <ListToolbar onRefresh={() => void admins.refetch()} refreshing={admins.isRefetching}>
        <Button
          variant="outline"
          iconStart={<PlusIcon />}
          onClick={() => {
            add.reset();
            setUserIdDraft('');
            setUserIdError(null);
            setAddOpen(true);
          }}
        >
          {t('pages.admins.addAdmin')}
        </Button>
      </ListToolbar>

      {admins.isError ? <Alert tone="error">{errorMessage(admins.error)}</Alert> : null}
      {admins.isPending || admins.data !== undefined ? (
        <div>
          <TableShell
            columns={columns}
            data={pagination.items}
            rowKey={(row) => row.telegram_user_id}
            loading={admins.isPending}
            emptyText={search.length === 0 ? t('pages.admins.emptyAdmins') : t('layout.koi.noMatches')}
          />
          <ListFooter
            count={pagination.total}
            page={pagination.page}
            pageCount={pagination.pageCount}
            onPageChange={pagination.onPageChange}
          />
        </div>
      ) : null}

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!open && !add.isPending) {
            setAddOpen(false);
          }
        }}
        title={t('pages.admins.addTitle')}
        description={t('pages.admins.addDescription')}
        footer={
          <>
            <Button variant="ghost" color="secondary" disabled={add.isPending} onClick={() => setAddOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="admin-add-form" loading={add.isPending} loadingLabel={t('pages.admins.adding')}>
              {t('pages.admins.add')}
            </Button>
          </>
        }
      >
        <form
          id="admin-add-form"
          noValidate
          className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}
          onSubmit={(event) => {
            event.preventDefault();
            submitAdd();
          }}
        >
          <Field label={t('pages.admins.userIdLabel')} error={userIdError ?? undefined}>
            <Input
              inputMode="numeric"
              placeholder={t('pages.admins.userIdPlaceholder')}
              value={userIdDraft}
              onChange={(event) => {
                setUserIdDraft(event.target.value);
                setUserIdError(null);
              }}
              dir="ltr"
            />
          </Field>
          {add.isError ? (
            <p role="alert" className={css({ margin: '0', color: 'error-text', overflowWrap: 'anywhere' })}>
              {errorMessage(add.error)}
            </p>
          ) : null}
        </form>
      </Dialog>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setRemoveOpen(false);
          }
        }}
        title={t('pages.admins.removeTitle', { id: removing?.telegram_user_id ?? '' })}
        description={t('pages.admins.removeDescription')}
        confirmText={t('pages.admins.removeConfirm')}
        cancelText={t('common.cancel')}
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
