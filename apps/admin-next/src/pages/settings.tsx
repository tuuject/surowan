import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { KvList, ListPageHeader, MonoValue, PasskeysCard, ToneBadge } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { updateCredentials } from '@/lib/api/auth.ts';
import type { ConfigApplyResponse } from '@/lib/api/config.ts';
import { applyConfigFile } from '@/lib/api/config.ts';
import type { Credentials } from '@/lib/api/core.ts';
import { ApiError } from '@/lib/api/core.ts';
import { errorMessage } from '@/lib/errors';
import { configStatusQuery, passkeysQuery, sessionQuery } from '@/lib/queries';
import { useProviderWrite } from '@/lib/use-provider-write';

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function PathList({
  paths,
  noneLabel,
}: {
  readonly paths: readonly string[];
  readonly noneLabel: string;
}): ReactElement {
  if (paths.length === 0) {
    return <span className={css({ color: 'text-muted' })}>{noneLabel}</span>;
  }
  return <MonoValue value={paths.join(', ')} />;
}

function AppliedResult({ result }: { readonly result: ConfigApplyResponse }): ReactElement {
  const { t } = useTranslation();
  return (
    <KvList
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

export default function SettingsPage(): ReactElement {
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
    // A form page reads in one column, as the template's 个人设置: the header and every card share it.
    <div className={css({ maxWidth: '768px', marginInline: 'auto', '& > * + *': { marginBlockStart: '6' } })}>
      <ListPageHeader title={t('layout.nav.settings')} />
      <Panel
        title={t('models.settings.adminCredentials')}
        description={t('models.settings.adminCredentialsDescription')}
      >
        <form
          noValidate
          onSubmit={handleSubmit(onSubmit)}
          className={css({ display: 'flex', flexDirection: 'column', gap: '4', maxWidth: '480px' })}
        >
          <Field label={t('models.settings.newUsername')} error={errors.username?.message}>
            <Input
              autoComplete="username"
              {...register('username', {
                required: t('models.settings.usernameRequired'),
                pattern: {
                  value: /^[A-Za-z0-9._-]{3,32}$/,
                  message: t('models.settings.usernamePattern'),
                },
              })}
            />
          </Field>
          <Field label={t('models.settings.newPassword')} error={errors.password?.message}>
            <Input
              type="password"
              autoComplete="new-password"
              {...register('password', {
                required: t('models.settings.passwordRequired'),
                minLength: { value: 12, message: t('models.settings.passwordMin') },
              })}
            />
          </Field>
          {success ? (
            <p role="status" className={css({ margin: '0', color: 'text-brand' })}>
              {t('models.settings.credentialsUpdated')}
            </p>
          ) : null}
          {failure === null ? null : <Alert tone="error">{failure}</Alert>}
          <div className={css({ display: 'flex', gap: '2', marginBlockStart: '2' })}>
            <Button
              type="submit"
              loading={isSubmitting || mutation.isPending}
              loadingLabel={t('models.settings.updating')}
            >
              {t('models.settings.updateCredentials')}
            </Button>
          </div>
        </form>
      </Panel>

      {session.data?.passkeys_enabled === true ? <PasskeysCard /> : null}

      <Panel
        title={t('models.settings.configFile')}
        description={t('models.settings.configFileDescription')}
        action={
          current === undefined ? undefined : (
            <Button
              variant="outline"
              loading={applyMutation.isPending}
              loadingLabel={t('models.settings.applying')}
              onClick={() => applyMutation.mutate()}
            >
              {t('models.settings.applyConfigFile')}
            </Button>
          )
        }
      >
        {status.isPending ? (
          <p className={css({ margin: '0', color: 'text-muted' })}>{t('common.loading')}</p>
        ) : status.isError || current === undefined ? (
          <Alert tone="error">{errorMessage(status.error)}</Alert>
        ) : (
          <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
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
                        {current.last_error.code}: {current.last_error.message}（{current.last_error.at}）
                      </span>
                    ),
                },
              ]}
            />
            {applyFailure === null ? null : <Alert tone="error">{applyFailure}</Alert>}
            {applyResult === null ? null : <AppliedResult result={applyResult} />}
          </div>
        )}
      </Panel>
    </div>
  );
}
