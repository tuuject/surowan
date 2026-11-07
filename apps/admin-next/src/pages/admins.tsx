import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
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
  useClientPagination,
} from '@/components/business';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import type { BotAdminEntry } from '@/lib/api/admin.ts';
import { addBotAdmin, removeBotAdmin } from '@/lib/api/admin.ts';
import { errorMessage } from '@/lib/errors';
import { useListQuery } from '@/lib/list-query';
import { adminsQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';

const ADMIN_ID_PATTERN = /^\d{1,15}$/;
const EMPTY_FILTERS = { search: '' };

export default function AdminsPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useListQuery(EMPTY_FILTERS);
  const search = query.value.search;
  const [addOpen, setAddOpen] = useState(false);
  const [userIdDraft, setUserIdDraft] = useState('');
  const [userIdError, setUserIdError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<BotAdminEntry | null>(null);

  const admins = useQuery(adminsQuery);

  const add = useMutation({
    mutationFn: (userId: number) => addBotAdmin({ telegram_user_id: userId }, admins.data?.revision ?? ''),
    onSuccess: (view) => {
      setAddOpen(false);
      setUserIdDraft('');
      setUserIdError(null);
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
      setRemoving(null);
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
      render: (row) => (
        <Button type="button" size="sm" variant="destructive" onClick={() => setRemoving(row)}>
          {t('pages.admins.remove')}
        </Button>
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
    <div className="space-y-5">
      <ListPageHeader title={t('layout.nav.botAdmins')} />
      <Alert>
        <Info className="text-foreground" />
        <AlertTitle>{t('pages.admins.alertTitle')}</AlertTitle>
        <AlertDescription>
          {t('pages.admins.alertDesc1')} <code>/pause</code> {t('pages.admins.alertDesc2')} <code>/resume</code>{' '}
          {t('pages.admins.alertDesc3')} <code>@userinfobot</code>
          {t('pages.admins.alertDesc4')} <code>telegram.admins</code> {t('pages.admins.alertDesc5')}
        </AlertDescription>
      </Alert>

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
        <Button type="button" onClick={() => setAddOpen(true)}>
          {t('pages.admins.addAdmin')}
        </Button>
      </ListToolbar>

      {admins.isError ? (
        <p role="alert" className="text-destructive text-sm break-words">
          {errorMessage(admins.error)}
        </p>
      ) : null}
      {admins.isPending || admins.data !== undefined ? (
        <div>
          <TableShell
            columns={columns}
            data={pagination.items}
            rowKey={(row) => row.telegram_user_id}
            loading={admins.isPending}
            frame={false}
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

      <Dialog open={addOpen} onOpenChange={(open) => !open && setAddOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('pages.admins.addTitle')}</DialogTitle>
            <DialogDescription>{t('pages.admins.addDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="admin-user-id">{t('pages.admins.userIdLabel')}</Label>
            <Input
              id="admin-user-id"
              inputMode="numeric"
              placeholder={t('pages.admins.userIdPlaceholder')}
              value={userIdDraft}
              onChange={(event) => {
                setUserIdDraft(event.target.value);
                setUserIdError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  submitAdd();
                }
              }}
            />
            {userIdError !== null ? <p className="text-destructive text-sm">{userIdError}</p> : null}
            {add.isError ? <p className="text-destructive text-sm break-words">{errorMessage(add.error)}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" onClick={submitAdd} disabled={add.isPending}>
              {add.isPending ? t('pages.admins.adding') : t('pages.admins.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
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
