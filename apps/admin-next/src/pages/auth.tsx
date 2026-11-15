import { startAuthentication } from '@simplewebauthn/browser';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Card } from '@tuuject/koi-react/card';
import { Divider } from '@tuuject/koi-react/divider';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Trans, useTranslation } from 'react-i18next';
import { LanguageToggle } from '@/components/app-shell/LanguageToggle';
import {
  SAFE_BOTTOM,
  SAFE_LEFT,
  SAFE_RIGHT,
  SAFE_TOP,
  TITLEBAR_HEIGHT,
  TOP_ROW_CLEAR_RIGHT,
} from '@/components/app-shell/shared';
import { ThemeToggle } from '@/components/app-shell/ThemeToggle';
import { TechText } from '@/components/business/bidi-text';
import {
  createFirstAdmin,
  login,
  loginWithPairingCode,
  passkeyLoginOptions,
  passkeyLoginVerify,
} from '@/lib/api/auth.ts';
import type { Credentials } from '@/lib/api/core.ts';
import { ApiError } from '@/lib/api/core.ts';
import { isWebAuthnAvailable, passkeyErrorMessage } from '@/lib/passkeys';
import { sessionQuery } from '@/lib/queries';

const pageClass = css({
  minHeight: '100%',
  display: 'grid',
  placeItems: 'center',
  paddingBlockStart: `max(token(spacing.4), ${SAFE_TOP})`,
  paddingInlineEnd: `max(token(spacing.4), ${SAFE_RIGHT})`,
  paddingBlockEnd: `max(token(spacing.4), ${SAFE_BOTTOM})`,
  paddingInlineStart: `max(token(spacing.4), ${SAFE_LEFT})`,
});

const cardClass = css({ width: 'min(400px, 100%)', boxSizing: 'border-box' });

const brandRow = css({ display: 'flex', alignItems: 'center', gap: '3', marginBlockEnd: '6' });
const logoClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 'control-lg',
  height: 'control-lg',
  borderRadius: 'xl',
  bg: 'secondary-solid',
  color: 'on-secondary-solid',
  textStyle: 'heading-3',
  fontWeight: 'bold',
  flexShrink: '0',
});

/**
 * The login/setup frame: the same safe-area and desktop-title-bar reservations
 * as the shell, with the language and theme switches available before sign-in.
 */
function AuthLayout({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className={pageClass}>
      <div
        aria-hidden="true"
        data-app-region="drag"
        className={css({ position: 'fixed', top: 0, insetInline: 0, height: TITLEBAR_HEIGHT })}
      />
      <div
        className={css({
          position: 'fixed',
          top: `max(token(spacing.4), ${SAFE_TOP})`,
          // physical: the clearance below is `TOP_ROW_CLEAR_RIGHT`, a physical window-controls/safe-area inset,
          // so the control sits on the same physical side it clears (and a macOS-style title bar keeps it visible).
          right: `max(token(spacing.4), ${TOP_ROW_CLEAR_RIGHT})`,
          display: 'flex',
          gap: '1',
        })}
      >
        <LanguageToggle />
        <ThemeToggle />
      </div>
      {/* The template's sign-in card: one Card, the product mark, then the form. */}
      <Card className={cardClass}>
        <div className={brandRow}>
          <span className={logoClass} aria-hidden="true">
            S
          </span>
          <div>
            <h1 className={css({ margin: '0', textStyle: 'heading-2', color: 'text' })}>{title}</h1>
            <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>{t('brand.name')}</p>
          </div>
        </div>
        <p className={css({ margin: '0', marginBlockEnd: '5', color: 'text-muted' })}>{description}</p>
        {children}
      </Card>
    </div>
  );
}

const formClass = css({ display: 'flex', flexDirection: 'column', gap: '4' });
const alternativesClass = css({ marginBlockStart: '4', display: 'flex', flexDirection: 'column', gap: '3' });

export function LoginForm({ passkeysEnabled }: { readonly passkeysEnabled: boolean }): ReactElement {
  const { t } = useTranslation();
  const [method, setMethod] = useState<'password' | 'code'>('password');
  if (method === 'code') {
    return (
      <AuthLayout title={t('brand.loginTitle')} description={t('pages.auth.codeDescription')}>
        <PairingCodeForm onBack={() => setMethod('password')} />
      </AuthLayout>
    );
  }
  return <PasswordLoginForm passkeysEnabled={passkeysEnabled} onUseCode={() => setMethod('code')} />;
}

function PasswordLoginForm({
  passkeysEnabled,
  onUseCode,
}: {
  readonly passkeysEnabled: boolean;
  readonly onUseCode: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const webAuthnAvailable = isWebAuthnAvailable();

  const loginMutation = useMutation({
    mutationFn: login,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? `${error.code}: ${error.message}` : t('common.requestFailed'));
    },
  });

  const passkeyMutation = useMutation({
    // Discoverable passkeys: the server's options carry no username, so the
    // authenticator picks the credential for this origin.
    mutationFn: async () => {
      const options = await passkeyLoginOptions();
      const response = await startAuthentication({ optionsJSON: options });
      return passkeyLoginVerify(response);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
    onError: (error) => {
      setFailure(passkeyErrorMessage(error));
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Credentials>();

  const onSubmit = (data: Credentials) => {
    setFailure(null);
    loginMutation.mutate(data);
  };

  return (
    <AuthLayout title={t('brand.loginTitle')} description={t('pages.auth.loginDescription')}>
      <form onSubmit={handleSubmit(onSubmit)} className={formClass}>
        <Field id="username" label={t('pages.auth.username')} error={errors.username?.message}>
          <Input
            autoComplete="username"
            autoFocus
            {...register('username', {
              required: t('pages.auth.usernameRequired'),
              pattern: {
                value: /^[A-Za-z0-9._-]{3,32}$/,
                message: t('pages.auth.usernamePattern'),
              },
            })}
            dir="ltr"
          />
        </Field>
        <Field id="password" label={t('pages.auth.password')} error={errors.password?.message}>
          <Input
            type="password"
            autoComplete="current-password"
            {...register('password', { required: t('pages.auth.passwordRequired') })}
            dir="ltr"
          />
        </Field>
        {loginMutation.isError && failure !== null ? <Alert tone="error">{failure}</Alert> : null}
        <Button type="submit" size="lg" fullWidth loading={isSubmitting} loadingLabel={t('pages.auth.signingIn')}>
          {t('pages.auth.signIn')}
        </Button>
      </form>
      <div className={alternativesClass}>
        <Divider />
        {passkeysEnabled ? (
          webAuthnAvailable ? (
            <>
              <Button
                type="button"
                variant="outline"
                color="secondary"
                size="lg"
                fullWidth
                loading={passkeyMutation.isPending}
                loadingLabel={t('pages.auth.passkeySigningIn')}
                onClick={() => {
                  setFailure(null);
                  passkeyMutation.mutate();
                }}
              >
                {t('pages.auth.passkeySignIn')}
              </Button>
              {passkeyMutation.isError && failure !== null ? <Alert tone="error">{failure}</Alert> : null}
            </>
          ) : (
            <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>
              {t('pages.auth.passkeyUnavailable')}
            </p>
          )
        ) : null}
        <Button type="button" variant="outline" color="secondary" size="lg" fullWidth onClick={onUseCode}>
          {t('pages.auth.codeSignIn')}
        </Button>
      </div>
    </AuthLayout>
  );
}

const PAIRING_CODE_PATTERN = /^\s*pwp_[A-Za-z0-9_-]{32}\s*$/;

/**
 * The one-time code sign-in: the operator mints the code on the server with
 * `surowan pairing create --web` and pastes it here. Surrounding whitespace from
 * a terminal copy is tolerated and trimmed before the request.
 */
function PairingCodeForm({ onBack }: { readonly onBack: () => void }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);

  const codeMutation = useMutation({
    mutationFn: loginWithPairingCode,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? `${error.code}: ${error.message}` : t('common.requestFailed'));
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<{ code: string }>();

  const onSubmit = (data: { code: string }) => {
    setFailure(null);
    codeMutation.mutate(data.code.trim());
  };

  return (
    <>
      <form onSubmit={handleSubmit(onSubmit)} className={formClass}>
        <Field
          id="pairing-code"
          label={t('pages.auth.code')}
          error={errors.code?.message}
          help={
            <Trans
              i18nKey="pages.auth.codeHelp"
              components={{ command: <TechText className={css({ fontFamily: 'mono' })} /> }}
            />
          }
        >
          <Input
            autoComplete="one-time-code"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            placeholder="pwp_…"
            className={css({ fontFamily: 'mono' })}
            {...register('code', {
              required: t('pages.auth.codeRequired'),
              pattern: { value: PAIRING_CODE_PATTERN, message: t('pages.auth.codePattern') },
            })}
            dir="ltr"
          />
        </Field>
        {failure !== null ? <Alert tone="error">{failure}</Alert> : null}
        <Button
          type="submit"
          size="lg"
          fullWidth
          loading={codeMutation.isPending}
          loadingLabel={t('pages.auth.signingIn')}
        >
          {t('pages.auth.signIn')}
        </Button>
      </form>
      <div className={alternativesClass}>
        <Divider />
        <Button type="button" variant="outline" color="secondary" size="lg" fullWidth onClick={onBack}>
          {t('pages.auth.passwordSignIn')}
        </Button>
      </div>
    </>
  );
}

export function SetupForm(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);

  const setupMutation = useMutation({
    mutationFn: createFirstAdmin,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? `${error.code}: ${error.message}` : t('common.requestFailed'));
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Credentials>();

  const onSubmit = (data: Credentials) => {
    setFailure(null);
    setupMutation.mutate(data);
  };

  return (
    <AuthLayout title={t('pages.auth.setupTitle')} description={t('pages.auth.setupDescription')}>
      <form onSubmit={handleSubmit(onSubmit)} className={formClass}>
        <Field id="username" label={t('pages.auth.username')} error={errors.username?.message}>
          <Input
            autoComplete="username"
            autoFocus
            {...register('username', {
              required: t('pages.auth.usernameRequired'),
              pattern: {
                value: /^[A-Za-z0-9._-]{3,32}$/,
                message: t('pages.auth.usernamePattern'),
              },
            })}
            dir="ltr"
          />
        </Field>
        <Field id="password" label={t('pages.auth.password')} error={errors.password?.message}>
          <Input
            type="password"
            autoComplete="new-password"
            {...register('password', {
              required: t('pages.auth.passwordRequired'),
              minLength: { value: 12, message: t('pages.auth.passwordMinLength') },
            })}
            dir="ltr"
          />
        </Field>
        {failure ? <Alert tone="error">{failure}</Alert> : null}
        <Button type="submit" size="lg" fullWidth loading={isSubmitting} loadingLabel={t('pages.auth.creating')}>
          {t('pages.auth.createAccount')}
        </Button>
      </form>
    </AuthLayout>
  );
}
