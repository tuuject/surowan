import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { KvList, MonoValue } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import { agentModelConfig, isThinkingLevel, supportedThinkingLevels, writeErrorMessage } from '@/lib/model-manager.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';
import type { ProvidersView } from '@/lib/api/providers.ts';
import { setAgentThinkingLevel } from '@/lib/api/models.ts';
import type { ThinkingLevel } from '@/lib/api/models.ts';

/**
 * What the bot runs on right now, whichever provider the page has selected:
 * the agent model with the thinking effort every invocation uses, and the
 * vision model. Only the effort is edited here; the models are switched from
 * their rows.
 */
export function InUsePanel({
  view,
  revision,
}: {
  readonly view: ProvidersView;
  readonly revision: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const agentModel = agentModelConfig(view);
  const current = view.agent.thinking_level;
  // Without a resolvable agent model the current level, if any, is the only one
  // this page can vouch for.
  const levels = agentModel !== null ? supportedThinkingLevels(agentModel) : current === null ? [] : [current];
  // An unset level must stay pickable even when the model offers just one.
  const levelLocked = levels.length === 0 || (levels.length < 2 && current !== null);

  const setLevel = useMutation({
    mutationFn: (level: ThinkingLevel) => setAgentThinkingLevel(level, revision),
    onSuccess: (result) => {
      write.succeeded(result.apply);
    },
    onError: (error) => {
      toast.error(writeErrorMessage(error));
      write.failed(error);
    },
  });

  return (
    <Panel title={t('models.models.inUse.title')}>
      <KvList
        items={[
          {
            label: t('models.models.inUse.agentModel'),
            value:
              view.agent.provider === null || view.agent.model === null ? (
                <span className="text-muted-foreground">{t('models.models.inUse.notConfigured')}</span>
              ) : (
                <MonoValue value={`${view.agent.provider} / ${view.agent.model}`} />
              ),
          },
          {
            label: t('models.models.inUse.thinkingEffort'),
            value: (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Select
                  value={current ?? ''}
                  disabled={setLevel.isPending || levelLocked}
                  onValueChange={(value) => {
                    if (isThinkingLevel(value) && value !== current) {
                      setLevel.mutate(value);
                    }
                  }}
                >
                  <SelectTrigger size="sm" className="w-32" aria-label={t('models.models.inUse.thinkingEffort')}>
                    <SelectValue placeholder={t('models.models.inUse.levelUnset')} />
                  </SelectTrigger>
                  <SelectContent>
                    {levels.map((level) => (
                      <SelectItem key={level} value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground text-xs">{t('models.models.inUse.resetsNote')}</span>
              </span>
            ),
          },
          {
            label: t('models.models.inUse.visionModel'),
            value:
              view.vision.provider === null || view.vision.model === null ? (
                <span className="text-muted-foreground">{t('models.models.inUse.notConfigured')}</span>
              ) : (
                <MonoValue value={`${view.vision.provider} / ${view.vision.model}`} />
              ),
          },
        ]}
      />
    </Panel>
  );
}
