import { useMutation } from '@tanstack/react-query';
import type React from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { KvList, MonoValue } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { type ProvidersView, type ProviderView, putToolModel, type ThinkingLevel } from '@/lib/api.ts';
import {
  isConfigConflict,
  isTextCapable,
  isThinkingLevel,
  supportedThinkingLevels,
  writeErrorMessage,
} from '@/lib/model-manager.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

interface Pick {
  readonly alias: string;
  readonly model: string;
  readonly levels: readonly ThinkingLevel[];
}

/**
 * The system-wide auxiliary model. It reuses the provider registry above: the
 * picker walks the same provider/model list the table shows, and the thinking
 * levels come from the model that is picked. `inherit` writes nothing but an
 * explicit fallback marker, so an agent-model switch keeps moving the tool
 * model with it.
 */
export function ToolModelPanel({
  view,
  revision,
}: {
  readonly view: ProvidersView;
  readonly revision: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const [pickerOpen, setPickerOpen] = useState(false);

  const tool = view.tool_model;

  const save = useMutation({
    mutationFn: (
      target:
        | { readonly inherit: true }
        | { readonly alias: string; readonly model: string; readonly level: ThinkingLevel },
    ) =>
      'inherit' in target
        ? putToolModel({ inherit: true }, revision)
        : putToolModel({ provider: target.alias, model: target.model, thinking_level: target.level }, revision),
    onSuccess: (result, target) => {
      setPickerOpen(false);
      write.succeeded(result.apply);
      toast.success(
        'inherit' in target ? t('models.models.toolModel.savedInherited') : t('models.models.toolModel.saved'),
      );
    },
    onError: (error) => {
      write.failed(error);
      if (isConfigConflict(error)) {
        setPickerOpen(false);
        toast.error(t('models.models.toolModel.conflict'));
      }
    },
  });

  return (
    <Panel
      title={t('models.models.toolModel.label')}
      action={
        <div className="flex flex-wrap items-center gap-2">
          {tool.inherited ? null : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={save.isPending}
              onClick={() => save.mutate({ inherit: true })}
            >
              {t('models.models.toolModel.inherit')}
            </Button>
          )}
          <Button type="button" size="sm" disabled={save.isPending} onClick={() => setPickerOpen(true)}>
            {t('models.models.toolModel.select')}
          </Button>
        </div>
      }
    >
      <KvList
        items={[
          {
            label: t('models.models.toolModel.label'),
            value: (
              <span className="flex flex-wrap items-center gap-2">
                <MonoValue value={`${tool.provider} / ${tool.model} · ${tool.thinking_level}`} />
                {tool.inherited ? (
                  <span className="text-muted-foreground text-xs">{t('models.models.toolModel.inherited')}</span>
                ) : null}
              </span>
            ),
          },
        ]}
      />
      <p className="text-muted-foreground mt-2 text-xs">{t('models.models.toolModel.description')}</p>
      {save.isError && !isConfigConflict(save.error) ? (
        <p className="text-destructive mt-2 text-sm break-words">{writeErrorMessage(save.error)}</p>
      ) : null}
      {pickerOpen ? (
        <ToolModelPicker
          open
          view={view}
          pending={save.isPending}
          current={tool}
          onClose={() => {
            if (!save.isPending) {
              setPickerOpen(false);
            }
          }}
          onSubmit={(alias, model, level) => save.mutate({ alias, model, level })}
        />
      ) : null}
    </Panel>
  );
}

function ToolModelPicker({
  open,
  view,
  pending,
  current,
  onClose,
  onSubmit,
}: {
  readonly open: boolean;
  readonly view: ProvidersView;
  readonly pending: boolean;
  readonly current: ProvidersView['tool_model'];
  readonly onClose: () => void;
  readonly onSubmit: (alias: string, model: string, level: ThinkingLevel) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [pick, setPick] = useState<Pick | null>(() => {
    const provider = view.providers.find((candidate) => candidate.alias === current.provider);
    const model = provider?.models.find((candidate) => candidate.id === current.model);
    if (provider === undefined || model === undefined) {
      return null;
    }
    return { alias: provider.alias, model: model.id, levels: supportedThinkingLevels(model) };
  });
  const [level, setLevel] = useState<ThinkingLevel>(current.thinking_level);

  const options = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows: { readonly provider: ProviderView; readonly id: string; readonly levels: readonly ThinkingLevel[] }[] =
      [];
    for (const provider of view.providers) {
      for (const model of provider.models) {
        if (!isTextCapable(model)) {
          continue;
        }
        if (needle.length > 0 && !`${provider.alias}/${model.id}`.toLowerCase().includes(needle)) {
          continue;
        }
        rows.push({ provider, id: model.id, levels: supportedThinkingLevels(model) });
      }
    }
    return rows;
  }, [view, search]);

  const levels = pick?.levels ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('models.models.toolModel.pickerTitle')}</DialogTitle>
          <DialogDescription>{t('models.models.toolModel.pickerDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            aria-label={t('models.models.toolModel.pickerSearch')}
            placeholder={t('models.models.toolModel.pickerSearch')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="max-h-64 overflow-auto rounded-md border">
            {options.length === 0 ? (
              <p className="text-muted-foreground p-3 text-sm">{t('models.models.toolModel.pickerEmpty')}</p>
            ) : (
              <ul>
                {options.map((option) => {
                  const active = pick !== null && pick.alias === option.provider.alias && pick.model === option.id;
                  const key = `${option.provider.alias}/${option.id}`;
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        aria-pressed={active}
                        className={
                          active
                            ? 'bg-accent text-accent-foreground w-full px-3 py-2 text-left text-sm'
                            : 'hover:bg-accent/50 w-full px-3 py-2 text-left text-sm'
                        }
                        onClick={() => {
                          setPick({ alias: option.provider.alias, model: option.id, levels: option.levels });
                          setLevel(option.levels[0] ?? 'off');
                        }}
                      >
                        <span className="font-mono">{key}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="tool-model-level">{t('models.models.toolModel.levelLabel')}</Label>
            <Select
              value={level}
              disabled={pick === null || levels.length < 2}
              onValueChange={(value) => {
                if (isThinkingLevel(value)) {
                  setLevel(value);
                }
              }}
            >
              <SelectTrigger
                id="tool-model-level"
                className="w-44"
                aria-label={t('models.models.toolModel.levelLabel')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {levels.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            disabled={pick === null || pending}
            onClick={() => {
              if (pick !== null) {
                onSubmit(pick.alias, pick.model, level);
              }
            }}
          >
            {pending ? t('models.models.toolModel.saving') : t('models.models.toolModel.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
