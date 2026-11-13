import { Checkbox } from '@tuuject/koi-react/checkbox';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { RadioGroup } from '@tuuject/koi-react/radio-group';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Textarea } from '@tuuject/koi-react/textarea';
import type { TFunction } from 'i18next';
import { type ReactElement, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RecurringTargetOption } from '@/lib/api/recurring-alarms.ts';
import {
  formRules,
  incompleteBuilder,
  PROMPT_MAX_CHARACTERS,
  promptLength,
  type RecurringFormState,
  switchMode,
  TITLE_MAX_CHARACTERS,
  targetKey,
} from '@/lib/recurring-form.ts';
import { RuleBuilder } from './rule-builder.tsx';
import { SchedulePreview } from './schedule-preview.tsx';

const PREVIEW_DEBOUNCE_MS = 300;

export interface RecurringFormErrors {
  readonly title?: string;
  readonly prompt?: string;
  readonly target?: string;
}

export function targetLabel(
  t: TFunction,
  option: Pick<
    RecurringTargetOption,
    'host_kind' | 'chat_title' | 'telegram_chat_id' | 'chat_id' | 'message_thread_id'
  >,
): string {
  if (option.host_kind === 'playground') {
    return t('pages.recurringAlarms.roomLabel', { title: option.chat_title ?? option.chat_id });
  }
  const chat = option.chat_title ?? option.telegram_chat_id ?? option.chat_id;
  return option.message_thread_id === '0'
    ? chat
    : [chat, t('pages.recurringAlarms.topicLabel', { id: option.message_thread_id })].join(t('common.separator'));
}

/**
 * The fields shared by the create and edit dialogs. The schedule preview
 * follows the rules and zone 300 ms after the last edit: each change re-arms
 * one timer from the event handler, so no effect watches the state.
 */
export function AlarmFormFields({
  state,
  onChange,
  targets,
  errors,
  disabled,
  editing,
}: {
  readonly state: RecurringFormState;
  readonly onChange: (state: RecurringFormState) => void;
  /** Create only: the target is fixed once saved. */
  readonly targets: readonly RecurringTargetOption[];
  readonly errors: RecurringFormErrors;
  readonly disabled: boolean;
  readonly editing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [previewInput, setPreviewInput] = useState(() => ({ rules: formRules(state), timeZone: state.timeZone }));
  const [cronOnly, setCronOnly] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const change = (next: RecurringFormState): void => {
    onChange(next);
    const rules = formRules(next);
    if (JSON.stringify(rules) === JSON.stringify(previewInput.rules) && next.timeZone === previewInput.timeZone) {
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPreviewInput({ rules, timeZone: next.timeZone.trim() }), PREVIEW_DEBOUNCE_MS);
  };

  const incomplete = incompleteBuilder(state);
  const current = targets.find((option) => targetKey(option) === state.target);

  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
      <Field
        label={t('pages.recurringAlarms.fieldTitle')}
        help={t('pages.recurringAlarms.fieldTitleHelp')}
        error={errors.title}
      >
        <Input
          value={state.title}
          disabled={disabled}
          maxLength={TITLE_MAX_CHARACTERS}
          onChange={(event) => change({ ...state, title: event.target.value })}
        />
      </Field>
      <Field
        label={t('pages.recurringAlarms.fieldTarget')}
        help={editing ? t('pages.recurringAlarms.fieldTargetHelp') : undefined}
        error={errors.target}
      >
        <Select
          value={state.target}
          disabled={disabled || editing}
          placeholder={t('pages.recurringAlarms.fieldTarget')}
          onChange={(event) => change({ ...state, target: event.target.value })}
          options={(editing && current === undefined ? [] : targets).map((option) => ({
            value: targetKey(option),
            label: option.available
              ? targetLabel(t, option)
              : t('pages.recurringAlarms.targetUnavailable', {
                  label: targetLabel(t, option),
                  reason: option.reason ?? '',
                }),
            disabled: !option.available && !editing,
          }))}
        />
      </Field>
      <Field label={t('pages.recurringAlarms.fieldTimeZone')} help={t('pages.recurringAlarms.fieldTimeZoneHelp')}>
        <Input
          value={state.timeZone}
          disabled={disabled}
          spellCheck={false}
          className={css({ fontFamily: 'mono' })}
          onChange={(event) => change({ ...state, timeZone: event.target.value })}
        />
      </Field>
      {/* Not a Koi Field: it would label every nested control "Schedule". */}
      <section aria-label={t('pages.recurringAlarms.schedule')}>
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '3' })}>
          <div>
            <div className={css({ textStyle: 'label' })}>{t('pages.recurringAlarms.schedule')}</div>
            <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.recurringAlarms.ruleHelp')}</p>
          </div>
          <RadioGroup
            orientation="horizontal"
            value={state.mode}
            disabled={disabled}
            onChange={(value) => {
              const next = switchMode(state, value === 'cron' ? 'cron' : 'builder');
              setCronOnly(next === undefined);
              if (next !== undefined) {
                change(next);
              }
            }}
            options={[
              { value: 'builder', label: t('pages.recurringAlarms.modeBuilder') },
              { value: 'cron', label: t('pages.recurringAlarms.modeCron') },
            ]}
          />
          {cronOnly ? (
            <p className={css({ textStyle: 'small', color: 'warning-text' })}>{t('pages.recurringAlarms.cronOnly')}</p>
          ) : null}
          {state.mode === 'builder' ? (
            <RuleBuilder
              rules={state.builder}
              incomplete={incomplete}
              disabled={disabled}
              onChange={(builder) => change({ ...state, builder })}
            />
          ) : (
            <>
              <Textarea
                aria-label={t('pages.recurringAlarms.modeCron')}
                rows={4}
                value={state.cronText}
                disabled={disabled}
                spellCheck={false}
                className={css({ fontFamily: 'mono' })}
                placeholder="0 8 * * *"
                onChange={(event) => change({ ...state, cronText: event.target.value })}
              />
              <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.recurringAlarms.cronHelp')}</p>
            </>
          )}
          {incomplete.size === 0 ? (
            <SchedulePreview rules={previewInput.rules} timeZone={previewInput.timeZone} />
          ) : null}
        </div>
      </section>
      <Field
        label={t('pages.recurringAlarms.fieldPrompt')}
        help={`${t('pages.recurringAlarms.fieldPromptHelp')} ${t('pages.recurringAlarms.promptCount', { count: promptLength(state.prompt) })}`}
        error={errors.prompt}
      >
        <Textarea
          rows={6}
          value={state.prompt}
          disabled={disabled}
          onChange={(event) => change({ ...state, prompt: event.target.value })}
        />
      </Field>
      <Checkbox
        label={t('pages.recurringAlarms.fieldEnabled')}
        description={t('pages.recurringAlarms.fieldEnabledHelp')}
        checked={state.enabled}
        disabled={disabled}
        onCheckedChange={(enabled) => change({ ...state, enabled })}
      />
    </div>
  );
}

export function validateForm(t: TFunction, state: RecurringFormState): RecurringFormErrors {
  const errors: { title?: string; prompt?: string; target?: string } = {};
  if (state.title.trim().length === 0) {
    errors.title = t('pages.recurringAlarms.required');
  }
  if (state.prompt.trim().length === 0) {
    errors.prompt = t('pages.recurringAlarms.required');
  } else if (promptLength(state.prompt) > PROMPT_MAX_CHARACTERS) {
    errors.prompt = t('pages.recurringAlarms.promptCount', { count: promptLength(state.prompt) });
  }
  if (state.target.length === 0) {
    errors.target = t('pages.recurringAlarms.required');
  }
  return errors;
}
