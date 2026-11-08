import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Field } from '@tuuject/koi-react/field';
import { SuccessIcon } from '@tuuject/koi-react/icons';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { sizes } from '@tuuject/koi-tokens/dimensions';
import { type ReactElement, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormActionBar } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import type { ChatThinkingReset, ThinkingLevel } from '@/lib/api/models.ts';
import type { ProvidersView } from '@/lib/api/providers.ts';
import { applyFeedback, isThinkingLevel, supportedThinkingLevels, writeErrorMessage } from '@/lib/model-manager.ts';
import { providersQuery } from '@/lib/queries.ts';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';
import {
  changeCount,
  changedRoles,
  draftRoles,
  editLevel,
  editModel,
  INHERIT,
  modelForKey,
  type RoleEdits,
  type RolesDraft,
} from './draft.ts';
import { configuredPlaceholder, ModelSelect } from './model-select.tsx';
import { RolesSaveError, type RolesSaveResult, saveRoles } from './save.ts';
import { ThinkingResetDialog } from './thinking-reset-dialog.tsx';
import type { ModelRole } from './writes.ts';

/**
 * The Models page form, laid out like the Koi admin template's settings pages:
 * one Card per job the bot gives a model (Agent, Vision, Tool), its fields
 * stacked label-above, and a sticky action bar that counts the unsaved changes
 * and saves them together. Changes stay a draft until saved; the Providers
 * page's "Use as" toggles are the one-click path.
 */
export function RolesForm({ view }: { readonly view: ProvidersView }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const write = useProviderWrite();
  const [edits, setEdits] = useState<RoleEdits>({});
  const [resets, setResets] = useState<readonly ChatThinkingReset[]>([]);
  const draft = draftRoles(view, edits);
  const count = changeCount(view, draft);
  const changed = new Set(changedRoles(view, draft));

  // The edits of the roles that went through give way to the file only once
  // the refreshed view is in, so the controls never flash the old values.
  const settle = async (result: RolesSaveResult): Promise<void> => {
    await queryClient.refetchQueries({ queryKey: providersQuery.queryKey }, { cancelRefetch: false });
    setEdits((previous) => {
      const next = { ...previous };
      for (const role of result.saved) {
        delete next[role];
      }
      return next;
    });
    setResets(result.resets);
  };

  const save = useMutation({
    mutationFn: ({ snapshot, target }: { readonly snapshot: ProvidersView; readonly target: RolesDraft }) =>
      saveRoles(snapshot, target),
    onSuccess: async (result) => {
      const feedback = applyFeedback(result.apply);
      toast.success(feedback.title, { description: feedback.description });
      write.refresh();
      await settle(result);
    },
    onError: async (error) => {
      write.failed(error);
      if (error instanceof RolesSaveError) {
        await settle(error.result);
      }
    },
  });

  const saveError = !save.isError
    ? null
    : save.error instanceof RolesSaveError && save.error.result.saved.size > 0
      ? t('models.models.roles.form.partial', { message: writeErrorMessage(save.error.cause) })
      : writeErrorMessage(save.error instanceof RolesSaveError ? save.error.cause : save.error);

  const status =
    count > 0 ? (
      t('models.models.roles.form.pending', { count })
    ) : save.isSuccess ? (
      <span className={css({ display: 'inline-flex', alignItems: 'center', gap: '2' })}>
        <SuccessIcon size={sizes['icon-sm']} className={css({ flex: 'none', color: 'text-brand' })} />
        {t('models.models.roles.form.saved')}
      </span>
    ) : (
      t('models.models.roles.form.unchanged')
    );

  const pickModel = (role: ModelRole, model: string): void =>
    setEdits((previous) => editModel(view, previous, role, model));
  const pickLevel = (role: ModelRole, level: ThinkingLevel): void =>
    setEdits((previous) => editLevel(previous, role, level));

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (count > 0 && !save.isPending) {
          save.mutate({ snapshot: view, target: draft });
        }
      }}
    >
      <fieldset
        disabled={save.isPending}
        className={css({
          display: 'flex',
          flexDirection: 'column',
          gap: '6',
          minWidth: '0',
          margin: '0',
          padding: '0',
          border: 'none',
        })}
      >
        <RoleCard
          title={t('models.models.roles.agent.title')}
          description={t('models.models.roles.agent.description')}
          changed={changed.has('agent')}
          model={
            <ModelSelect
              view={view}
              accepts="text"
              value={draft.agent.model}
              placeholder={configuredPlaceholder(view.agent.provider, view.agent.model, t('models.models.roles.unset'))}
              disabled={save.isPending}
              onPick={(choice) => pickModel('agent', choice.value)}
            />
          }
          thinking={
            <ThinkingField
              view={view}
              slot={draft.agent}
              // An unset level must stay pickable even when the model offers just one.
              allowSingle={draft.agent.level === null}
              help={(reasoning) =>
                reasoning ? t('models.models.roles.agent.resetsNote') : t('models.models.roles.notReasoning')
              }
              onChange={(level) => pickLevel('agent', level)}
            />
          }
        />
        <RoleCard
          title={t('models.models.roles.vision.title')}
          description={t('models.models.roles.vision.description')}
          changed={changed.has('vision')}
          model={
            <ModelSelect
              view={view}
              accepts="image"
              value={draft.vision.model}
              placeholder={configuredPlaceholder(
                view.vision.provider,
                view.vision.model,
                t('models.models.roles.unset'),
              )}
              disabled={save.isPending}
              onPick={(choice) => pickModel('vision', choice.value)}
            />
          }
          thinking={
            <ThinkingField
              view={view}
              slot={draft.vision}
              help={(reasoning) => (reasoning ? undefined : t('models.models.roles.notReasoning'))}
              onChange={(level) => pickLevel('vision', level)}
            />
          }
        />
        <RoleCard
          title={t('models.models.roles.tool.title')}
          description={t('models.models.roles.tool.description')}
          changed={changed.has('tool')}
          model={
            <ModelSelect
              view={view}
              accepts="text"
              value={draft.tool.model}
              leading={{
                label: t('models.models.roles.tool.defaultGroup'),
                items: [{ value: INHERIT, label: t('models.models.roles.tool.inherit'), ref: null }],
              }}
              placeholder={configuredPlaceholder(
                view.tool_model.provider,
                view.tool_model.model,
                t('models.models.roles.unset'),
              )}
              disabled={save.isPending}
              onPick={(choice) => pickModel('tool', choice.value)}
            />
          }
          thinking={
            <ThinkingField
              view={view}
              slot={draft.tool}
              // An inherited level belongs to the Agent card; changing it here
              // would silently pin the Tool Model.
              locked={draft.tool.model === INHERIT}
              help={(reasoning) =>
                draft.tool.model === INHERIT
                  ? t('models.models.roles.tool.levelInherited')
                  : reasoning
                    ? undefined
                    : t('models.models.roles.notReasoning')
              }
              onChange={(level) => pickLevel('tool', level)}
            />
          }
        />
      </fieldset>
      <FormActionBar
        status={status}
        error={saveError}
        submitLabel={t('models.models.roles.form.save')}
        submittingLabel={t('models.models.roles.form.saving')}
        submitting={save.isPending}
        submitDisabled={count === 0}
        discardLabel={t('models.models.roles.form.discard')}
        discardDisabled={count === 0}
        onDiscard={() => {
          save.reset();
          setEdits({});
        }}
      />
      <ThinkingResetDialog resets={resets} onClose={() => setResets([])} />
    </form>
  );
}

/**
 * One job: its name and what it is for, then the model and, under it, the
 * effort that model runs at. A brand dot beside the title marks a card with
 * unsaved changes, as the template's section list does; screen readers get
 * the words in the body instead, so the region keeps its name.
 */
function RoleCard({
  title,
  description,
  changed,
  model,
  thinking,
}: {
  readonly title: string;
  readonly description: string;
  readonly changed: boolean;
  readonly model: ReactNode;
  readonly thinking: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Panel
      title={
        <span className={css({ display: 'inline-flex', alignItems: 'center', gap: '2' })}>
          {title}
          {changed ? (
            <span
              aria-hidden="true"
              className={css({ flex: 'none', width: '6px', height: '6px', borderRadius: 'full', bg: 'text-brand' })}
            />
          ) : null}
        </span>
      }
      description={description}
    >
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
        {/* Read after the heading, not in it: the card's name stays the same while it is edited. */}
        {changed ? <span className={css({ srOnly: true })}>{t('models.models.roles.form.cardChanged')}</span> : null}
        <Field label={t('models.models.roles.modelLabel')}>{model}</Field>
        {thinking}
      </div>
    </Panel>
  );
}

function ThinkingField({
  view,
  slot,
  locked = false,
  allowSingle = false,
  help,
  onChange,
}: {
  readonly view: ProvidersView;
  readonly slot: RolesDraft[ModelRole];
  /** Shown but not editable (an inherited level). */
  readonly locked?: boolean;
  /** Keep a lone level pickable, for a role whose level is still unset. */
  readonly allowSingle?: boolean;
  /** The note under the control; told whether the model reasons. */
  readonly help: (reasoning: boolean) => string | undefined;
  readonly onChange: (level: ThinkingLevel) => void;
}): ReactElement {
  const { t } = useTranslation();
  const config = modelForKey(view, slot.model)?.config ?? null;
  const levels = config === null ? [] : supportedThinkingLevels(config);
  // The value in use stays listed even when the model no longer declares it.
  const options = slot.level === null || levels.includes(slot.level) ? levels : [...levels, slot.level];
  const note = help(config === null || config.reasoning);
  return (
    <Field label={t('models.models.roles.thinkingLabel')} {...(note === undefined ? {} : { help: note })}>
      <Select
        className={css({ maxWidth: '240px' })}
        placeholder={t('models.models.roles.levelUnset')}
        value={slot.level ?? ''}
        disabled={locked || config === null || (options.length < 2 && !allowSingle)}
        onChange={(event) => {
          const next = event.target.value;
          if (isThinkingLevel(next)) {
            onChange(next);
          }
        }}
      >
        {options.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </Select>
    </Field>
  );
}
