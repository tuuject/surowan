import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, type ErrorComponentProps, useNavigate } from '@tanstack/react-router';
import { Button } from '@tuuject/koi-react/button';
import { Spinner } from '@tuuject/koi-react/spinner';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useTranslation } from 'react-i18next';
import { AppShell } from '@/components/app-shell/AppShell';
import { logout } from '@/lib/api/auth.ts';
import type { SessionState } from '@/lib/api/core.ts';
import { ApiError } from '@/lib/api/core.ts';
import { sessionQuery } from '@/lib/queries';
import { LoginForm, SetupForm } from '@/pages/auth';

const UNAUTHENTICATED_SESSION: SessionState = {
  setup_required: false,
  authenticated: false,
  username: null,
  expires_at: null,
  passkeys_enabled: false,
  has_password: null,
};

interface RouterContext {
  readonly queryClient: QueryClient;
}

function Centered({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className={css({ display: 'flex', minHeight: '100%', alignItems: 'center', justifyContent: 'center' })}>
      {children}
    </div>
  );
}

function AuthGate(): React.ReactNode {
  const { data, isPending, error } = useQuery(sessionQuery);
  const { t } = useTranslation();

  if (isPending) {
    return (
      <Centered>
        <Spinner label={t('common.loading')} />
      </Centered>
    );
  }

  if (error) {
    const message = error instanceof ApiError ? `${error.code}: ${error.message}` : t('common.requestFailed');
    return (
      <Centered>
        <div className={css({ textAlign: 'center' })}>
          <p className={css({ color: 'error-text', fontWeight: 'bold' })}>{t('common.requestFailed')}</p>
          <p className={css({ textStyle: 'small', color: 'text-muted', marginTop: '2' })}>{message}</p>
        </div>
      </Centered>
    );
  }

  if (data === undefined) {
    return (
      <Centered>
        <Spinner label={t('common.loading')} />
      </Centered>
    );
  }

  if (data.setup_required) {
    return <SetupForm />;
  }
  if (!data.authenticated) {
    // The session is the single source for whether passkeys are configured:
    // a server built without `admin.public_url` never shows the passkey entry.
    return <LoginForm passkeysEnabled={data.passkeys_enabled} />;
  }

  return <AdminShell username={data.username ?? 'admin'} />;
}

function isSessionQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === sessionQuery.queryKey[0];
}

function AdminShell({ username }: { readonly username: string }): React.ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      // Order matters: cancel in-flight protected fetches, drop every cached
      // entry EXCEPT the session query, then force the session query to
      // refetch (the same mechanism the global 401 handler uses) so the
      // AuthGate re-evaluates to `authenticated: false` before navigating
      // back to the root. clear()+setQueryData alone does not reliably
      // re-render the gate (the removed query's observer is not re-notified
      // by setQueryData), which is why the refetch is driven explicitly.
      queryClient.cancelQueries();
      queryClient.removeQueries({ predicate: (query) => !isSessionQueryKey(query.queryKey) });
      queryClient.setQueryData(sessionQuery.queryKey, UNAUTHENTICATED_SESSION);
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
      await navigate({ to: '/' });
    },
    onError: async () => {
      // Local sign-out must not leave the user on a dead shell or an error
      // screen even when the logout request itself failed: drop protected
      // data and set the (still-live) session query to unauthenticated so the
      // AuthGate renders the login form immediately, without needing another
      // network round-trip.
      queryClient.cancelQueries();
      queryClient.removeQueries({ predicate: (query) => !isSessionQueryKey(query.queryKey) });
      queryClient.setQueryData(sessionQuery.queryKey, UNAUTHENTICATED_SESSION);
      await navigate({ to: '/' });
    },
  });

  return <AppShell username={username} onSignOut={() => signOut.mutate()} />;
}

/**
 * Fallback for errors that escape into the router. API failures are handled
 * per-page (useQuery error states) or by the global 401 handler in
 * lib/query-client.ts, so this only catches unexpected render/route errors.
 */
function RouteErrorFallback({ error }: ErrorComponentProps): React.ReactElement {
  const { t } = useTranslation();
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Centered>
      <section className={css({ width: 'min(440px, 100%)' })}>
        <div className={css({ marginBlockEnd: '4' })}>
          <h2 className={css({ textStyle: 'heading-3' })}>{t('common.requestFailed')}</h2>
          <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('layout.routeError.description')}</p>
        </div>
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
          <p className={css({ textStyle: 'small', color: 'text-muted', overflowWrap: 'anywhere' })}>{message}</p>
          <Button type="button" onClick={() => window.location.reload()}>
            {t('common.retry')}
          </Button>
        </div>
      </section>
    </Centered>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: AuthGate,
  errorComponent: RouteErrorFallback,
});
