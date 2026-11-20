import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListPageHeader } from '@/components/business';
import { DecisionGateForm } from '@/components/decision-gate/settings-form.tsx';
import { type DecisionGatePatch, type DecisionGateResult, updateDecisionGate } from '@/lib/api/decision-gate.ts';
import type { SecretInput } from '@/lib/api/keychain.ts';
import { errorMessage } from '@/lib/errors';
import { isConfigConflict } from '@/lib/model-manager';
import { decisionGateQuery, keychainQuery } from '@/lib/queries';
import { useProviderWrite } from '@/lib/use-provider-write';

/** The non-secret half of one save; the credential travels through `holdSecret`. */
type DecisionGateSaveVariables = {
  readonly patch: Omit<DecisionGatePatch, 'api_key'>;
  readonly revision: string;
  readonly withSecret: boolean;
};

/**
 * Saves one patch and publishes the refreshed view. The mutation lives above
 * the form: an apply failure moves the file revision, which remounts the form,
 * and its error must survive that.
 *
 * A submitted plaintext never becomes a mutation variable — TanStack Query keeps
 * those for the observer's lifetime, after success and after failure. The form
 * parks it in this ref and `mutationFn` moves it into the request before its
 * first await, so the cache only ever sees the field patch and a boolean.
 */
function useDecisionGateSave(onSaved: () => void) {
  const queryClient = useQueryClient();
  const write = useProviderWrite();
  const pendingSecret = useRef<SecretInput | null>(null);
  const mutation = useMutation({
    mutationFn: ({ patch, revision }: DecisionGateSaveVariables): Promise<DecisionGateResult> => {
      const secret = pendingSecret.current;
      pendingSecret.current = null;
      return updateDecisionGate(secret === null ? patch : { ...patch, api_key: secret }, revision);
    },
    onSuccess: (result, variables) => {
      queryClient.setQueryData(decisionGateQuery.queryKey, {
        revision: result.revision,
        saved: result.saved,
        active: result.active,
        key_configured: result.key_configured,
        ...(result.key_source === undefined ? {} : { key_source: result.key_source }),
      });
      if (variables.withSecret) {
        void queryClient.invalidateQueries({ queryKey: keychainQuery.queryKey });
      }
      write.succeeded(result.apply);
      onSaved();
    },
    onError: (error) => {
      // A conflict means another editor moved the revision: keep this form (and
      // its draft) on screen until the explicit Reload action drops it, instead
      // of refetching a new revision that remounts the form under the user.
      if (!isConfigConflict(error)) {
        write.failed(error);
      }
    },
  });
  return {
    ...mutation,
    holdSecret: (secret: SecretInput): void => {
      pendingSecret.current = secret;
    },
  };
}

export default function DecisionGatePage(): ReactElement {
  const { t } = useTranslation();
  const settings = useQuery(decisionGateQuery);
  // A save that leaves the file unchanged (a rotated single-use key, a no-op)
  // keeps the revision, so the form's identity also moves with every save.
  const [generation, setGeneration] = useState(0);
  const save = useDecisionGateSave(() => setGeneration((current) => current + 1));
  const current = settings.data;

  return (
    <div className={css({ maxWidth: '960px', marginInline: 'auto', '& > * + *': { marginBlockStart: '6' } })}>
      <ListPageHeader title={t('layout.nav.decisionGate')} />
      {settings.isPending ? (
        <p className={css({ margin: '0', color: 'text-muted' })}>{t('common.loading')}</p>
      ) : settings.isError || current === undefined ? (
        <Alert tone="error" title={t('decisionGate.loadFailed')} role="alert">
          {errorMessage(settings.error)}
        </Alert>
      ) : (
        <DecisionGateForm key={`${current.revision}:${String(generation)}`} initial={current} save={save} />
      )}
    </div>
  );
}
