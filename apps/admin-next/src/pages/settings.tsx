import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { KvList, ListPageHeader, MonoValue, PasskeysCard, ToneBadge } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { Button } from '@tuuject/koi-react/button';
import { Input } from '@tuuject/koi-react/input';
import { Label } from '@/components/ui/label';
import { updateCredentials } from '@/lib/api/auth.ts';
import type { ConfigApplyResponse } from '@/lib/api/config.ts';
import { applyConfigFile } from '@/lib/api/config.ts';
import type { Credentials } from '@/lib/api/core.ts';
import { ApiError } from '@/lib/api/core.ts';
import { errorMessage } from '@/lib/errors';
import { configStatusQuery, passkeysQuery, sessionQuery } from '@/lib/queries';
import { useProviderWrite } from '@/lib/use-provider-write';
import { css } from '@tuuject/koi-react/styled-system/css';

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function PathList({
  paths,
  noneLabel,
}: {
  readonly paths: readonly string[];
  readonly noneLabel: string;
}): React.ReactElement {
  if (paths.length === 0) {
    return <span className={css({ color: 'text-muted' })}>{noneLabel}</span>;
  }
  return <MonoValue value={paths.join(', ')} />;
}

function AppliedResult({ result }: { readonly result: ConfigApplyResponse }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <KvList
      className={css({ marginBlockStart: '3' })}
      items={[
        {
          label: t('models.settings.applied'),
          value: <PathList paths={result.applied} noneLabel={t('models.settings.none')} />,
        },
        {
          label: t('models.settings.restartRequired'),
          value: <PathList paths={result.restart_required} noneLabel={t('models.settings.none')} />,
        },
        {
          label: t('models.settings.outsideServe'),
          value: <PathList paths={result.outside_serve} noneLabel={t('models.settings.none')} />,
        },
      ]}
    />
  );
}

export default function SettingsPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const write = useProviderWrite();
  const [success, setSuccess] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<ConfigApplyResponse | null>(null);
  const [applyFailure, setApplyFailure] = useState<string | null>(null);

  const status = useQuery(configStatusQuery);
  // The AuthGate already holds the session; reading it here just joins the
  // cache entry and gates the passkey card on the configured `admin.public_url`.
  const session = useQuery(sessionQuery);

  const mutation = useMutation({
    mutationFn: updateCredentials,
    onSuccess: async () => {
      setSuccess(true);
      setFailure(null);
      // A password (re)set changes `has_password` in the session and the
      // passkey list; refresh both so the last-passkey guard stays correct.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey }),
      ]);
    },
    onError: (error) => {
      setSuccess(false);
      setFailure(error instanceof ApiError ? `${error.code}: ${error.message}` : t('common.requestFailed'));
    },
  });

  const applyMutation = useMutation({
    mutationFn: applyConfigFile,
    onSuccess: (result) => {
      setApplyResult(result);
      setApplyFailure(null);
      write.refresh();
    },
    onError: (error) => {
      // Show the real error next to the button, then refresh: a failed reload
      // keeps the active configuration and the file hash, but records the error
      // as the last error.
      setApplyResult(null);
      setApplyFailure(errorMessage(error));
      write.refresh();
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Credentials>();

  const onSubmit = (data: Credentials) => {
    setFailure(null);
    setSuccess(false);
    mutation.mutate(data);
  };

  const current = status.data;

  return (
    <div className={css({ maxWidth: '64rem', '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('layout.nav.settings')} />
      <Panel
        title={t('models.settings.adminCredentials')}
        description={t('models.settings.adminCredentialsDescription')}
      >
        <form onSubmit={handleSubmit(onSubmit)} className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
            <Label htmlFor="username">{t('models.settings.newUsername')}</Label>
            <Input
              id="username"
              autoComplete="username"
              {...register('username', {
                required: t('models.settings.usernameRequired'),
                pattern: {
                  value: /^[A-Za-z0-9._-]{3,32}$/,
                  message: t('models.settings.usernamePattern'),
                },
              })}
            />
            {errors.username && (
              <p className={css({ textStyle: 'body', color: 'error-text' })}>{errors.username.message}</p>
            )}
          </div>
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
            <Label htmlFor="password">{t('models.settings.newPassword')}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              {...register('password', {
                required: t('models.settings.passwordRequired'),
                minLength: { value: 12, message: t('models.settings.passwordMin') },
              })}
            />
            {errors.password && (
              <p className={css({ textStyle: 'body', color: 'error-text' })}>{errors.password.message}</p>
            )}
          </div>
          {success && (
            <p className={css({ textStyle: 'body', color: 'text-brand' })}>{t('models.settings.credentialsUpdated')}</p>
          )}
          {failure && <p className={css({ textStyle: 'body', color: 'error-text' })}>{failure}</p>}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('models.settings.updating') : t('models.settings.updateCredentials')}
          </Button>
        </form>
      </Panel>

      {session.data?.passkeys_enabled === true ? <PasskeysCard /> : null}

      <Panel title={t('models.settings.configFile')} description={t('models.settings.configFileDescription')}>
        {status.isPending ? (
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('common.loading')}</p>
        ) : status.isError || current === undefined ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {errorMessage(status.error)}
          </p>
        ) : (
          <>
            <KvList
              items={[
                { label: t('models.settings.generation'), value: current.generation },
                {
                  label: t('models.settings.activeHash'),
                  value: <MonoValue value={shortHash(current.active_hash)} />,
                },
                { label: t('models.settings.fileHash'), value: <MonoValue value={shortHash(current.file_hash)} /> },
                {
                  label: t('models.settings.activeConfig'),
                  value:
                    current.active_hash === current.file_hash ? (
                      <ToneBadge tone="success">{t('models.settings.matchesFile')}</ToneBadge>
                    ) : (
                      <ToneBadge tone="warning">{t('models.settings.fileHasChanges')}</ToneBadge>
                    ),
                },
                {
                  label: t('models.settings.restartRequired'),
                  value: <PathList paths={current.restart_required} noneLabel={t('models.settings.none')} />,
                },
                {
                  label: t('models.settings.lastError'),
                  value:
                    current.last_error === null ? (
                      <span className={css({ color: 'text-muted' })}>{t('models.settings.none')}</span>
                    ) : (
                      <span className={css({ color: 'error-text' })}>
                        {current.last_error.code}: {current.last_error.message} ({current.last_error.at})
                      </span>
                    ),
                },
              ]}
            />
            <div className={css({ marginBlockStart: '4' })}>
              <Button
                type="button"
                disabled={applyMutation.isPending}
                onClick={() => {
                  applyMutation.mutate();
                }}
              >
                {applyMutation.isPending ? t('models.settings.applying') : t('models.settings.applyConfigFile')}
              </Button>
            </div>
            {applyFailure !== null && (
              <p
                className={css({
                  textStyle: 'body',
                  color: 'error-text',
                  marginBlockStart: '3',
                  overflowWrap: 'anywhere',
                })}
              >
                {applyFailure}
              </p>
            )}
            {applyResult !== null && <AppliedResult result={applyResult} />}
          </>
        )}
      </Panel>
    </div>
  );
}
