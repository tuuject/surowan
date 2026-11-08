import { Button } from '@tuuject/koi-react/button';
import { Checkbox } from '@tuuject/koi-react/checkbox';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { field } from '@tuuject/koi-react/styled-system/recipes';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LazyDetails } from '@/components/business';
import type { ThinkingLevel } from '@/lib/api/models.ts';
import { THINKING_LEVELS } from '@/lib/api/models.ts';
import type {
  DraftField,
  ModelInput,
  ModelMetadataDraft,
  ProviderApi,
  ProviderModelConfig,
} from '@/lib/api/providers.ts';
import i18n from '@/lib/i18n.ts';
import { type ModelFormState, modelFormToConfig, validateModelForm } from '@/lib/model-form.ts';
import {
  AUTO_COMPAT,
  compatFieldsForApi,
  draftFieldLabel,
  fieldSourceLabel,
  isDraftFieldUnconfirmed,
  matchLabel,
  modalityLabel,
  TOOL_SCHEMA_KEYWORDS_OPTIONS,
  unconfirmedFields,
} from '@/lib/model-manager.ts';

/** Koi Field's label, for the few controls that share one label with a status line or a second control. */
const fieldLabel = field().label;

const INPUT_MODALITIES: readonly ModelInput[] = ['text', 'image'];
const COST_FIELDS = ['input', 'output', 'cache_read', 'cache_write'] as const;
function costFieldLabel(field: (typeof COST_FIELDS)[number]): string {
  switch (field) {
    case 'input':
      return i18n.t('models.models.edit.costInput');
    case 'output':
      return i18n.t('models.models.edit.costOutput');
    case 'cache_read':
      return i18n.t('models.models.edit.costCacheRead');
    case 'cache_write':
      return i18n.t('models.models.edit.costCacheWrite');
  }
}

/**
 * One field label with its provenance: the metadata source the value came from,
 * and a marker when the admin still has to confirm it.
 */
function FieldLabel({
  htmlFor,
  label,
  draft,
  field,
}: {
  readonly htmlFor: string;
  readonly label: string;
  readonly draft: ModelMetadataDraft | null;
  readonly field: DraftField;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <span className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
      <label htmlFor={htmlFor} className={fieldLabel}>
        {label}
      </label>
      {draft === null ? null : (
        <>
          <span className={css({ textStyle: 'small', color: 'text-muted' })}>{fieldSourceLabel(draft, field)}</span>
          {isDraftFieldUnconfirmed(draft, field) ? (
            <span className={css({ textStyle: 'small', color: 'warning-text' })}>
              {t('models.models.edit.confirmMarker')}
            </span>
          ) : null}
        </>
      )}
    </span>
  );
}

export interface ModelEditDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly api: ProviderApi;
  readonly title: string;
  readonly description: string;
  readonly initial: ModelFormState;
  /** A model already in the file keeps its id: changing it is delete + add. */
  readonly lockId: boolean;
  readonly draft: ModelMetadataDraft | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSubmit: (model: ProviderModelConfig) => void;
}

export function ModelEditDialog({
  open,
  onOpenChange,
  api,
  title,
  description,
  initial,
  lockId,
  draft,
  pending,
  error,
  onSubmit,
}: ModelEditDialogProps): ReactElement {
  const { t } = useTranslation();
  // The form is initialized once, at mount: every caller renders this dialog
  // only while it has a target and remounts it (a fresh `key`) for the next one,
  // so there is no state to sync after the first render.
  const [form, setForm] = useState<ModelFormState>(initial);
  const [touched, setTouched] = useState(false);

  const errors = validateModelForm(form);
  const errorCount = Object.keys(errors).length;
  const compatFields = compatFieldsForApi(api);
  const showAdvanced = compatFields.length > 0;
  const confirmations = draft === null ? [] : unconfirmedFields(draft);
  const matchNote = draft === null ? null : matchLabel(draft.match);

  const toggleThinkingLevel = (level: ThinkingLevel): void => {
    setForm((previous) => ({
      ...previous,
      thinking_levels: previous.thinking_levels.includes(level)
        ? previous.thinking_levels.filter((value) => value !== level)
        : [...previous.thinking_levels, level],
    }));
  };

  const toggleInput = (modality: ModelInput): void => {
    setForm((previous) => ({
      ...previous,
      input: previous.input.includes(modality)
        ? previous.input.filter((value) => value !== modality)
        : [...previous.input, modality],
    }));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="lg"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            color="secondary"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={() => {
              setTouched(true);
              if (errorCount > 0) {
                return;
              }
              onSubmit(modelFormToConfig(form, api));
            }}
          >
            {pending ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
        {confirmations.length > 0 ? (
          <p className={css({ textStyle: 'small', color: 'warning-text' })}>
            {t('models.models.edit.confirmIntro', {
              fields: confirmations.map(draftFieldLabel).join(t('common.separator')),
            })}
          </p>
        ) : null}
        {/* Naming the match makes "confirm" actionable: a cross-provider or
              normalized hit is a lead from another deployment, not an answer. */}
        {matchNote === null ? null : <p className={css({ textStyle: 'small', color: 'text-muted' })}>{matchNote}</p>}
        <div className={css({ display: 'grid', gap: '4', md: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } })}>
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
            <FieldLabel htmlFor="model-id" label={t('models.models.edit.id')} draft={null} field="name" />
            <Input
              id="model-id"
              value={form.id}
              disabled={lockId}
              onChange={(event) => setForm((previous) => ({ ...previous, id: event.target.value }))}
            />
            {touched && errors.id !== undefined ? (
              <p className={css({ textStyle: 'body', color: 'error-text' })}>{errors.id}</p>
            ) : null}
          </div>
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
            <FieldLabel htmlFor="model-name" label={t('models.models.edit.name')} draft={draft} field="name" />
            <Input
              id="model-name"
              value={form.name}
              onChange={(event) => setForm((previous) => ({ ...previous, name: event.target.value }))}
            />
          </div>
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
            <FieldLabel
              htmlFor="model-context"
              label={t('models.models.edit.contextWindow')}
              draft={draft}
              field="context_window"
            />
            <Input
              id="model-context"
              type="number"
              min={1}
              step={1}
              value={form.context_window}
              onChange={(event) => setForm((previous) => ({ ...previous, context_window: event.target.value }))}
            />
            {touched && errors.context_window !== undefined ? (
              <p className={css({ textStyle: 'body', color: 'error-text' })}>{errors.context_window}</p>
            ) : null}
          </div>
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
            <FieldLabel
              htmlFor="model-max-tokens"
              label={t('models.models.edit.maxTokens')}
              draft={draft}
              field="max_tokens"
            />
            <Input
              id="model-max-tokens"
              type="number"
              min={1}
              step={1}
              value={form.max_tokens}
              onChange={(event) => setForm((previous) => ({ ...previous, max_tokens: event.target.value }))}
            />
            {touched && errors.max_tokens !== undefined ? (
              <p className={css({ textStyle: 'body', color: 'error-text' })}>{errors.max_tokens}</p>
            ) : null}
          </div>
        </div>

        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
          <FieldLabel htmlFor="model-input-text" label={t('models.models.edit.input')} draft={draft} field="input" />
          <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4' })}>
            {INPUT_MODALITIES.map((modality) => (
              <Checkbox
                key={modality}
                {...(modality === 'text' ? { id: 'model-input-text' } : {})}
                label={modalityLabel(modality)}
                checked={form.input.includes(modality)}
                onCheckedChange={() => toggleInput(modality)}
              />
            ))}
            <Checkbox
              label={t('models.models.edit.reasoning')}
              checked={form.reasoning}
              onCheckedChange={(checked) => setForm((previous) => ({ ...previous, reasoning: checked }))}
            />
            {draft === null ? null : (
              <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                {fieldSourceLabel(draft, 'reasoning')}
              </span>
            )}
          </div>
          {touched && errors.input !== undefined ? (
            <p className={css({ textStyle: 'body', color: 'error-text' })}>{errors.input}</p>
          ) : null}
        </div>

        {/* Levels only exist on a reasoning model; saving without reasoning
              drops them, so the row goes away with the checkbox. */}
        {form.reasoning ? (
          <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
            <FieldLabel
              htmlFor="model-thinking-off"
              label={t('models.models.edit.thinkingLevels')}
              draft={draft}
              field="thinking_levels"
            />
            <div
              className={css({
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                columnGap: '4',
                rowGap: '2',
              })}
            >
              {THINKING_LEVELS.map((level) => (
                <Checkbox
                  key={level}
                  {...(level === 'off' ? { id: 'model-thinking-off' } : {})}
                  label={level}
                  checked={form.thinking_levels.includes(level)}
                  onCheckedChange={() => toggleThinkingLevel(level)}
                />
              ))}
            </div>
            <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('models.models.edit.thinkingHint')}</p>
          </div>
        ) : null}

        <Field label={t('models.models.edit.toolSchema')} help={t('models.models.edit.toolSchemaHint')}>
          <Select
            className={css({ width: '100%', md: { width: '256px' } })}
            value={form.tool_schema_keywords}
            onChange={(event) => setForm((previous) => ({ ...previous, tool_schema_keywords: event.target.value }))}
          >
            {TOOL_SCHEMA_KEYWORDS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label()}
              </option>
            ))}
          </Select>
        </Field>

        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
          <FieldLabel htmlFor="model-cost-input" label={t('models.models.edit.cost')} draft={draft} field="cost" />
          <div className={css({ display: 'grid', gap: '2', md: { gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' } })}>
            {COST_FIELDS.map((field) => (
              <div key={field} className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
                <label htmlFor={`model-cost-${field}`} className={fieldLabel}>
                  {costFieldLabel(field)}
                </label>
                <Input
                  id={`model-cost-${field}`}
                  type="number"
                  min={0}
                  step="any"
                  value={form.cost[field]}
                  onChange={(event) =>
                    setForm((previous) => ({
                      ...previous,
                      cost: { ...previous.cost, [field]: event.target.value },
                    }))
                  }
                />
              </div>
            ))}
          </div>
          {touched && errors.cost !== undefined ? (
            <p className={css({ textStyle: 'body', color: 'error-text' })}>{errors.cost}</p>
          ) : null}
        </div>

        {showAdvanced ? (
          <LazyDetails summary={t('models.models.edit.advanced')} className={css({ textStyle: 'body' })}>
            <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' }, paddingBlockStart: '3' })}>
              <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('models.models.edit.advancedHint')}</p>
              {compatFields.map((spec) => (
                <div key={spec.field} className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
                  <label htmlFor={`compat-${spec.field}`} className={fieldLabel}>
                    {spec.label()}
                  </label>
                  <Select
                    id={`compat-${spec.field}`}
                    className={css({ width: '100%', md: { width: '256px' } })}
                    value={form.compat[spec.field] ?? AUTO_COMPAT}
                    onChange={(event) =>
                      setForm((previous) => ({
                        ...previous,
                        compat: { ...previous.compat, [spec.field]: event.target.value },
                      }))
                    }
                  >
                    <option value={AUTO_COMPAT}>{t('models.models.edit.auto')}</option>
                    {spec.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label()}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>
          </LazyDetails>
        ) : null}

        {error !== null ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>{error}</p>
        ) : null}
      </div>
    </Dialog>
  );
}
