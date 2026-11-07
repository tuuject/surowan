import { useMutation } from '@tanstack/react-query';
import { Select } from '@tuuject/koi-react/select';
import type React from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KvList, MonoValue } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { Badge } from '@tuuject/koi-react/badge';
import { Button } from '@tuuject/koi-react/button';
import { CheckIcon } from '@tuuject/koi-react/icons';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Input } from '@tuuject/koi-react/input';
import { Field } from '@tuuject/koi-react/field';
import type { ThinkingLevel } from '@/lib/api/models.ts';
import type { ProvidersView, ProviderView } from '@/lib/api/providers.ts';
import { putToolModel } from '@/lib/api/tools.ts';
import {
  isConfigConflict,
  isTextCapable,
  isThinkingLevel,
  supportedThinkingLevels,
  writeErrorMessage,
} from '@/lib/model-manager.ts';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

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
      description={t('models.models.toolModel.description')}
      action={
        <>
          {tool.inherited ? null : (
            <Button
              variant="ghost"
              color="secondary"
              disabled={save.isPending}
              onClick={() => save.mutate({ inherit: true })}
            >
              {t('models.models.toolModel.inherit')}
            </Button>
          )}
          <Button variant="outline" disabled={save.isPending} onClick={() => setPickerOpen(true)}>
            {t('models.models.toolModel.select')}
          </Button>
        </>
      }
    >
      <KvList
        items={[
          {
            label: t('models.models.toolModel.label'),
            value: (
              <span className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
                <MonoValue value={`${tool.provider} / ${tool.model}`} />
                <Badge>{tool.thinking_level}</Badge>
                {tool.inherited ? (
                  <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                    {t('models.models.toolModel.inherited')}
                  </span>
                ) : null}
              </span>
            ),
          },
        ]}
      />
      {save.isError && !isConfigConflict(save.error) ? (
        <p className={css({ textStyle: 'body', color: 'error-text', marginBlockStart: '2', overflowWrap: 'anywhere' })}>
          {writeErrorMessage(save.error)}
        </p>
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
  // A partial agent identity may leave the inherited level unset: start from a
  // level the picked model accepts instead of an `off` it may reject.
  const [level, setLevel] = useState<ThinkingLevel>(() => current.thinking_level ?? pick?.levels[0] ?? 'off');

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
      title={t('models.models.toolModel.pickerTitle')}
      description={t('models.models.toolModel.pickerDescription')}
      size="md"
      footer={
        <>
          <Button variant="ghost" color="secondary" disabled={pending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={pick === null || !pick.levels.includes(level)}
            loading={pending}
            loadingLabel={t('models.models.toolModel.saving')}
            onClick={() => {
              if (pick !== null) {
                onSubmit(pick.alias, pick.model, level);
              }
            }}
          >
            {t('models.models.toolModel.save')}
          </Button>
        </>
      }
    >
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '3' })}>
        <Input
          type="search"
          aria-label={t('models.models.toolModel.pickerSearch')}
          placeholder={t('models.models.toolModel.pickerSearch')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {/* Drawn like SelectPanel's list: a quiet framed panel of 36px option rows. */}
        <div
          className={css({
            maxHeight: '256px',
            overflow: 'auto',
            borderRadius: 'xl',
            borderWidth: '1px',
            borderColor: 'border',
            bg: 'surface',
            padding: '1',
          })}
        >
          {options.length === 0 ? (
            <p className={css({ margin: '0', color: 'text-muted', paddingInline: '3', paddingBlock: '2' })}>
              {t('models.models.toolModel.pickerEmpty')}
            </p>
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
                      className={css(
                        {
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '2',
                          width: '100%',
                          minHeight: 'control-md',
                          paddingInline: '3',
                          borderRadius: 'lg',
                          border: 'none',
                          bg: 'transparent',
                          color: 'text',
                          textAlign: 'start',
                          cursor: 'pointer',
                          transitionProperty: 'background-color',
                          transitionDuration: 'fast',
                          _hover: { bg: 'surface-muted' },
                          _focusVisible: { outline: '2px solid', outlineColor: 'focus-ring', outlineOffset: '-2px' },
                        },
                        active
                          ? { bg: 'action-subtle', color: 'on-action-subtle', _hover: { bg: 'action-subtle' } }
                          : {},
                      )}
                      onClick={() => {
                        setPick({ alias: option.provider.alias, model: option.id, levels: option.levels });
                        setLevel(option.levels[0] ?? 'off');
                      }}
                    >
                      <span className={css({ fontFamily: 'mono', truncate: true })}>{key}</span>
                      {active ? <CheckIcon className={css({ flexShrink: '0' })} /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <Field label={t('models.models.toolModel.levelLabel')}>
          <Select
            value={level}
            disabled={pick === null || levels.length < 2}
            onChange={(event) => {
              if (isThinkingLevel(event.target.value)) {
                setLevel(event.target.value);
              }
            }}
          >
            {levels.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
