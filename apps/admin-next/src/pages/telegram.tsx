import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog, KvList, MonoValue } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { TelegramStatusBadge, TelegramStatusReason, telegramBotLabel } from '@/components/telegram/telegram-status.tsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { TelegramConnectionState, TelegramView } from '@/lib/api/telegram.ts';
import { putTelegram } from '@/lib/api/telegram.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { telegramQuery } from '@/lib/queries';

function BotIdentity({ state }: { readonly state: TelegramConnectionState }): React.ReactElement {
  const { t } = useTranslation();
  const bot = state.bot;
  if (bot === undefined) {
    return <span className="text-muted-foreground text-sm">{t('pages.telegram.noBot')}</span>;
  }
  return (
    <span className="flex flex-wrap items-baseline gap-2">
      <MonoValue value={telegramBotLabel(bot)} />
      {bot.username === null ? null : <span className="text-muted-foreground text-xs">{bot.id}</span>}
    </span>
  );
}

function TelegramSettings({ view }: { readonly view: TelegramView }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');
  const [clearOpen, setClearOpen] = useState(false);

  const refresh = async (): Promise<void> => {
    await Promise.all(
      ['telegram', 'warnings', 'overview', 'config-status'].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
  };

  const save = useMutation({
    mutationFn: (revision: string) => putTelegram(token.trim(), revision),
    onSuccess: async () => {
      setToken('');
      toast.success(t('pages.telegram.saved'));
      await refresh();
    },
    onError: (error) => {
      toast.error(errorMessage(error));
      // A revision conflict means this view's If-Match is stale; refetch so the
      // next attempt is built on the file that is actually on disk.
      void queryClient.invalidateQueries({ queryKey: ['telegram'] });
    },
  });

  const clear = useMutation({
    mutationFn: (revision: string) => putTelegram(null, revision),
    onSuccess: async () => {
      setClearOpen(false);
      toast.success(t('pages.telegram.cleared'));
      await refresh();
    },
    onError: (error) => {
      toast.error(errorMessage(error));
      void queryClient.invalidateQueries({ queryKey: ['telegram'] });
    },
  });

  const pending = save.isPending || clear.isPending;
  const trimmed = token.trim();

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">{t('pages.telegram.title')}</h1>
        <p className="text-muted-foreground text-sm">{t('pages.telegram.description')}</p>
      </div>

      <Panel title={t('pages.telegram.connectionTitle')}>
        <KvList
          items={[
            {
              label: t('pages.telegram.fieldStatus'),
              value: (
                <span className="flex flex-wrap items-center gap-2">
                  <TelegramStatusBadge state={view.status} />
                  <TelegramStatusReason state={view.status} />
                </span>
              ),
            },
            {
              label: t('pages.telegram.fieldSince'),
              value: <span className="text-sm">{formatTime(view.status.since)}</span>,
            },
            { label: t('pages.telegram.fieldBot'), value: <BotIdentity state={view.status} /> },
          ]}
        />
      </Panel>

      <Panel title={t('pages.telegram.tokenTitle')}>
        <fieldset disabled={pending} className="min-w-0 space-y-4">
          <p className="text-sm">
            {view.token_configured ? t('pages.telegram.tokenConfigured') : t('pages.telegram.tokenMissing')}
          </p>
          {view.telegram_section_present ? null : (
            <p className="text-muted-foreground text-sm">{t('pages.telegram.sectionMissing')}</p>
          )}
          <div className="space-y-2">
            <Label htmlFor="telegram-token">{t('pages.telegram.tokenLabel')}</Label>
            <Input
              id="telegram-token"
              type="password"
              autoComplete="new-password"
              placeholder={t('pages.telegram.tokenPlaceholder')}
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
              }}
            />
            <p className="text-muted-foreground text-xs">{t('pages.telegram.tokenHint')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              disabled={trimmed.length === 0}
              onClick={() => {
                save.mutate(view.revision);
              }}
            >
              {save.isPending ? t('pages.telegram.saving') : t('pages.telegram.save')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!view.token_configured}
              onClick={() => setClearOpen(true)}
            >
              {t('pages.telegram.clear')}
            </Button>
          </div>
        </fieldset>
      </Panel>

      <ConfirmDialog
        open={clearOpen}
        onOpenChange={(open) => {
          if (!open && !clear.isPending) {
            setClearOpen(false);
          }
        }}
        title={t('pages.telegram.clearTitle')}
        description={t('pages.telegram.clearDescription')}
        confirmText={t('pages.telegram.clearConfirm')}
        destructive
        pending={clear.isPending}
        error={clear.isError ? errorMessage(clear.error) : null}
        onConfirm={() => clear.mutate(view.revision)}
      />
    </div>
  );
}

export default function TelegramPage(): React.ReactElement {
  const { t } = useTranslation();
  const query = useQuery(telegramQuery);

  if (query.isPending) {
    return (
      <div className="max-w-3xl space-y-4">
        <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
      </div>
    );
  }

  if (query.isLoadingError || query.data === undefined) {
    return (
      <div className="max-w-3xl space-y-4" role="alert">
        <p className="text-destructive text-sm">
          {t('pages.telegram.readFailed')}: {errorMessage(query.error)}
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          {t('common.reload')}
        </Button>
      </div>
    );
  }

  // A failed poll keeps the form mounted, so a token being typed survives it.
  return (
    <div className="space-y-4">
      {query.isError ? (
        <p className="text-destructive max-w-3xl text-sm break-words" role="alert">
          {t('pages.telegram.readFailed')}: {errorMessage(query.error)}
        </p>
      ) : null}
      <TelegramSettings view={query.data} />
    </div>
  );
}
