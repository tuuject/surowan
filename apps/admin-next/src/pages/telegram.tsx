import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@tuuject/koi-react/alert';
import { Field } from '@tuuject/koi-react/field';
import { ConfirmDialog, KvList, ListPageHeader, MonoValue } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { TelegramStatusBadge, TelegramStatusReason, telegramBotLabel } from '@/components/telegram/telegram-status.tsx';
import { Button } from '@tuuject/koi-react/button';
import { Input } from '@tuuject/koi-react/input';
import type { TelegramConnectionState, TelegramView } from '@/lib/api/telegram.ts';
import { putTelegram } from '@/lib/api/telegram.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { telegramQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

function BotIdentity({ state }: { readonly state: TelegramConnectionState }): React.ReactElement {
  const { t } = useTranslation();
  const bot = state.bot;
  if (bot === undefined) {
    return <span className={css({ textStyle: 'body', color: 'text-muted' })}>{t('pages.telegram.noBot')}</span>;
  }
  return (
    <span className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2' })}>
      <MonoValue value={telegramBotLabel(bot)} />
      {bot.username === null ? null : (
        <span className={css({ textStyle: 'small', color: 'text-muted' })}>{bot.id}</span>
      )}
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
    <>
      <Panel title={t('pages.telegram.connectionTitle')}>
        <KvList
          items={[
            {
              label: t('pages.telegram.fieldStatus'),
              value: (
                <span className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
                  <TelegramStatusBadge state={view.status} />
                  <TelegramStatusReason state={view.status} />
                </span>
              ),
            },
            {
              label: t('pages.telegram.fieldSince'),
              value: formatTime(view.status.since),
            },
            { label: t('pages.telegram.fieldBot'), value: <BotIdentity state={view.status} /> },
          ]}
        />
      </Panel>

      <Panel
        title={t('pages.telegram.tokenTitle')}
        description={view.token_configured ? t('pages.telegram.tokenConfigured') : t('pages.telegram.tokenMissing')}
      >
        <form
          noValidate
          className={css({ display: 'flex', flexDirection: 'column', gap: '4', maxWidth: '480px' })}
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length > 0 && !pending) {
              save.mutate(view.revision);
            }
          }}
        >
          {view.telegram_section_present ? null : (
            <p className={css({ margin: '0', color: 'text-muted' })}>{t('pages.telegram.sectionMissing')}</p>
          )}
          <Field label={t('pages.telegram.tokenLabel')} help={t('pages.telegram.tokenHint')}>
            <Input
              type="password"
              autoComplete="new-password"
              placeholder={t('pages.telegram.tokenPlaceholder')}
              value={token}
              disabled={pending}
              onChange={(event) => {
                setToken(event.target.value);
              }}
            />
          </Field>
          <div
            className={css({
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '2',
              marginBlockStart: '2',
            })}
          >
            <Button
              type="submit"
              disabled={trimmed.length === 0 || clear.isPending}
              loading={save.isPending}
              loadingLabel={t('pages.telegram.saving')}
            >
              {t('pages.telegram.save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              color="error"
              disabled={!view.token_configured || pending}
              onClick={() => {
                clear.reset();
                setClearOpen(true);
              }}
            >
              {t('pages.telegram.clear')}
            </Button>
          </div>
        </form>
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
    </>
  );
}

export default function TelegramPage(): React.ReactElement {
  const { t } = useTranslation();
  const query = useQuery(telegramQuery);

  return (
    <div className={css({ maxWidth: '768px', marginInline: 'auto', '& > * + *': { marginBlockStart: '6' } })}>
      <ListPageHeader title={t('pages.telegram.title')} description={t('pages.telegram.description')} />
      {query.isPending ? (
        <p className={css({ margin: '0', color: 'text-muted' })}>{t('common.loading')}</p>
      ) : query.isLoadingError || query.data === undefined ? (
        <Alert
          tone="error"
          title={t('pages.telegram.readFailed')}
          action={
            <Button size="sm" variant="ghost" color="secondary" onClick={() => void query.refetch()}>
              {t('common.reload')}
            </Button>
          }
        >
          {errorMessage(query.error)}
        </Alert>
      ) : (
        <>
          {/* A failed poll keeps the form mounted, so a token being typed survives it. */}
          {query.isError ? (
            <Alert tone="error" title={t('pages.telegram.readFailed')}>
              {errorMessage(query.error)}
            </Alert>
          ) : null}
          <TelegramSettings view={query.data} />
        </>
      )}
    </div>
  );
}
