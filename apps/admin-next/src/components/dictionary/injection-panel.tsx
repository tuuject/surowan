import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel } from '@/components/layout/panel';
import type { DictionaryInjectionMode } from '@/lib/api/dictionary.ts';
import { DICTIONARY_INJECTION_MODES, getDictionarySettings, putDictionarySettings } from '@/lib/api/dictionary.ts';
import { dictionaryErrorMessage, injectionModeHint, injectionModeLabel } from '@/lib/dictionary.ts';
import { dictionarySettingsQuery } from '@/lib/queries.ts';
import { toast } from '@/lib/toast.ts';

const INHERIT_VALUE = '__inherit__';

function isInjectionMode(value: string): value is DictionaryInjectionMode {
  return (DICTIONARY_INJECTION_MODES as readonly string[]).includes(value);
}

/**
 * Injection policy. The global mode and a group override are two different
 * endpoints: the global write carries no `chat`, the override write names the
 * Chat and accepts `null` to clear it. Each write re-reads its own revision
 * immediately before sending it, because a global write bumps the file hash
 * that every group read was holding — a revision captured at render time would
 * race the panel's own refresh and fail with `config_conflict`.
 */
export function InjectionPanel({ chatId }: { readonly chatId: string | null }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const globalSettings = useQuery(dictionarySettingsQuery(null));
  const groupSettings = useQuery({
    ...dictionarySettingsQuery(chatId),
    enabled: chatId !== null,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['dictionary-settings'] });
  };

  const saveGlobal = useMutation({
    mutationFn: async (mode: DictionaryInjectionMode) => {
      const current = await getDictionarySettings(null);
      return putDictionarySettings(mode, current.revision, null);
    },
    onSuccess: () => {
      toast.success(t('dictionary.injection.saved'));
      refresh();
    },
    onError: refresh,
  });

  const saveOverride = useMutation({
    mutationFn: async (mode: DictionaryInjectionMode | null) => {
      const current = await getDictionarySettings(chatId);
      return putDictionarySettings(mode, current.revision, chatId);
    },
    onSuccess: (_result, mode) => {
      toast.success(mode === null ? t('dictionary.injection.cleared') : t('dictionary.injection.saved'));
      refresh();
    },
    onError: refresh,
  });

  const globalMode = globalSettings.data?.injection_mode ?? 'on_demand';
  const overrideMode = groupSettings.data?.override_mode ?? null;
  const effective =
    chatId === null ? (globalSettings.data?.effective_mode ?? globalMode) : groupSettings.data?.effective_mode;

  return (
    <Panel title={t('dictionary.injection.title')}>
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
        <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('dictionary.injection.description')}</p>

        {globalSettings.isError ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {t('dictionary.injection.settingsFailed')}: {dictionaryErrorMessage(globalSettings.error)}
          </p>
        ) : null}

        <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '6' })}>
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <p className={css({ textStyle: 'label' })}>{t('dictionary.injection.globalMode')}</p>
            <Select
              className={css({ width: '176px' })}
              aria-label={t('dictionary.injection.globalMode')}
              value={globalMode}
              disabled={globalSettings.isPending || saveGlobal.isPending}
              onChange={(event) => {
                const value = event.target.value;
                if (isInjectionMode(value) && value !== globalMode) {
                  saveGlobal.mutate(value);
                }
              }}
            >
              {DICTIONARY_INJECTION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {injectionModeLabel(mode)}
                </option>
              ))}
            </Select>
            <p className={css({ textStyle: 'small', color: 'text-muted', maxWidth: '320px' })}>
              {injectionModeHint(globalMode)}
            </p>
          </div>

          {chatId === null ? null : (
            <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
              <p className={css({ textStyle: 'label' })}>{t('dictionary.injection.groupOverride')}</p>
              <Select
                className={css({ width: '224px' })}
                aria-label={t('dictionary.injection.groupOverride')}
                value={overrideMode ?? INHERIT_VALUE}
                disabled={groupSettings.isPending || saveOverride.isPending}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === INHERIT_VALUE) {
                    if (overrideMode !== null) {
                      saveOverride.mutate(null);
                    }
                    return;
                  }
                  if (isInjectionMode(value) && value !== overrideMode) {
                    saveOverride.mutate(value);
                  }
                }}
              >
                <option value={INHERIT_VALUE}>
                  {t('dictionary.injection.inheritOption', { mode: injectionModeLabel(globalMode) })}
                </option>
                {DICTIONARY_INJECTION_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {injectionModeLabel(mode)}
                  </option>
                ))}
              </Select>
              <p className={css({ textStyle: 'small', color: 'text-muted', maxWidth: '320px' })}>
                {t('dictionary.injection.overrideNote')}
              </p>
            </div>
          )}

          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
            <p className={css({ textStyle: 'label' })}>{t('dictionary.injection.effective')}</p>
            <p data-testid="effective-mode" className={css({ textStyle: 'body' })}>
              {effective === undefined ? '—' : injectionModeLabel(effective)}
            </p>
          </div>
        </div>

        {saveGlobal.isError || saveOverride.isError ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {dictionaryErrorMessage(saveGlobal.error ?? saveOverride.error)}
          </p>
        ) : null}

        <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('dictionary.injection.dedupeNote')}</p>
      </div>
    </Panel>
  );
}
