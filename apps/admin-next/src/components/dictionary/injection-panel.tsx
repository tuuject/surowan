import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Panel } from '@/components/layout/panel';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DICTIONARY_INJECTION_MODES,
  type DictionaryInjectionMode,
  getDictionarySettings,
  putDictionarySettings,
} from '@/lib/api.ts';
import { dictionaryErrorMessage, injectionModeHint, injectionModeLabel } from '@/lib/dictionary.ts';
import { dictionarySettingsQuery } from '@/lib/queries.ts';

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
export function InjectionPanel({ chatId }: { readonly chatId: string | null }): React.ReactElement {
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
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">{t('dictionary.injection.description')}</p>

        {globalSettings.isError ? (
          <p className="text-destructive text-sm break-words">
            {t('dictionary.injection.settingsFailed')}: {dictionaryErrorMessage(globalSettings.error)}
          </p>
        ) : null}

        <div className="flex flex-wrap items-start gap-6">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('dictionary.injection.globalMode')}</p>
            <Select
              value={globalMode}
              disabled={globalSettings.isPending || saveGlobal.isPending}
              onValueChange={(value) => {
                if (isInjectionMode(value) && value !== globalMode) {
                  saveGlobal.mutate(value);
                }
              }}
            >
              <SelectTrigger className="w-44" aria-label={t('dictionary.injection.globalMode')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DICTIONARY_INJECTION_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {injectionModeLabel(mode)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground max-w-80 text-xs">{injectionModeHint(globalMode)}</p>
          </div>

          {chatId === null ? null : (
            <div className="space-y-1">
              <p className="text-sm font-medium">{t('dictionary.injection.groupOverride')}</p>
              <Select
                value={overrideMode ?? INHERIT_VALUE}
                disabled={groupSettings.isPending || saveOverride.isPending}
                onValueChange={(value) => {
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
                <SelectTrigger className="w-56" aria-label={t('dictionary.injection.groupOverride')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT_VALUE}>
                    {t('dictionary.injection.inheritOption', { mode: injectionModeLabel(globalMode) })}
                  </SelectItem>
                  {DICTIONARY_INJECTION_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {injectionModeLabel(mode)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground max-w-80 text-xs">{t('dictionary.injection.overrideNote')}</p>
            </div>
          )}

          <div className="space-y-1">
            <p className="text-sm font-medium">{t('dictionary.injection.effective')}</p>
            <p data-testid="effective-mode" className="text-sm">
              {effective === undefined ? '—' : injectionModeLabel(effective)}
            </p>
          </div>
        </div>

        {saveGlobal.isError || saveOverride.isError ? (
          <p className="text-destructive text-sm break-words">
            {dictionaryErrorMessage(saveGlobal.error ?? saveOverride.error)}
          </p>
        ) : null}

        <p className="text-muted-foreground text-xs">{t('dictionary.injection.dedupeNote')}</p>
      </div>
    </Panel>
  );
}
