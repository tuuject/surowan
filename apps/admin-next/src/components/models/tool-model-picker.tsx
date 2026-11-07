import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { CheckIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ThinkingLevel } from '@/lib/api/models.ts';
import type { ProvidersView, ProviderView } from '@/lib/api/providers.ts';
import { isTextCapable, isThinkingLevel, supportedThinkingLevels } from '@/lib/model-manager.ts';

interface Pick {
  readonly alias: string;
  readonly model: string;
  readonly levels: readonly ThinkingLevel[];
}

/** The Tool Model picker: the same provider/model list the page renders, with its levels. */
export function ToolModelPicker({
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
