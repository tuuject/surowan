import { Button, IconButton } from '@tuuject/koi-react/button';
import { Checkbox } from '@tuuject/koi-react/checkbox';
import { PlusIcon, TrashIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type BuilderField,
  type BuilderRule,
  defaultBuilderRule,
  FIELD_KEYS,
  FIELD_RANGES,
  type FieldKey,
  parseFieldValues,
} from '@/lib/cron-builder.ts';
import { RULES_MAX } from '@/lib/recurring-form.ts';

const WEEKDAYS = ['0', '1', '2', '3', '4', '5', '6'] as const;

function sameValues(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * The `at` list of one field, typed as `0,30`. The raw text is local so a
 * half-typed `0,` keeps its comma; it is adopted from the prop only when the
 * prop stops being the echo of the current parse (a mode switch, a reset).
 */
function ValuesInput({
  field,
  fieldKey,
  label,
  disabled,
  onChange,
}: {
  readonly field: BuilderField;
  readonly fieldKey: FieldKey;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (values: readonly number[]) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [raw, setRaw] = useState(field.values.join(','));
  const [echoed, setEchoed] = useState<readonly number[]>(field.values);
  if (!sameValues(field.values, echoed)) {
    setEchoed(field.values);
    setRaw(field.values.join(','));
  }
  const range = FIELD_RANGES[fieldKey];
  return (
    <Input
      aria-label={label}
      value={raw}
      disabled={disabled}
      inputMode="numeric"
      placeholder={`${t('pages.recurringAlarms.valuesPlaceholder')} (${range.min}–${range.max})`}
      onChange={(event) => {
        const next = event.target.value;
        const parsed = parseFieldValues(next, fieldKey) ?? [];
        setRaw(next);
        setEchoed(parsed);
        onChange(parsed);
      }}
      dir="ltr"
    />
  );
}

function WeekdayPicker({
  values,
  disabled,
  onChange,
}: {
  readonly values: readonly number[];
  readonly disabled: boolean;
  readonly onChange: (values: readonly number[]) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className={css({ display: 'flex', flexWrap: 'wrap', columnGap: '3', rowGap: '1' })}>
      {WEEKDAYS.map((day) => {
        const value = Number(day);
        return (
          <Checkbox
            key={day}
            label={t(`pages.recurringAlarms.weekdays.${day}`)}
            checked={values.includes(value)}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange(checked ? [...values, value] : values.filter((existing) => existing !== value))
            }
          />
        );
      })}
    </div>
  );
}

function FieldEditor({
  rule,
  fieldKey,
  disabled,
  onChange,
}: {
  readonly rule: BuilderRule;
  readonly fieldKey: FieldKey;
  readonly disabled: boolean;
  readonly onChange: (field: BuilderField) => void;
}): ReactElement {
  const { t } = useTranslation();
  const field = rule[fieldKey];
  const label = t(`pages.recurringAlarms.field.${fieldKey}`);
  return (
    // A fieldset, not a Koi Field: Field labels every control inside with its
    // own label, which would give the mode and the value the same name.
    <fieldset
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: '2',
        border: 'none',
        padding: '0',
        margin: '0',
        minWidth: '0',
      })}
    >
      <legend className={css({ textStyle: 'label', padding: '0' })}>{label}</legend>
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
        <Select
          aria-label={t('pages.recurringAlarms.modeAria', { field: label })}
          value={field.mode}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              event.target.value === 'at'
                ? { mode: 'at', step: '', values: field.values }
                : { mode: 'every', step: field.step, values: [] },
            )
          }
          options={[
            { value: 'every', label: t('pages.recurringAlarms.every') },
            { value: 'at', label: t('pages.recurringAlarms.at') },
          ]}
        />
        {field.mode === 'every' ? (
          <Input
            aria-label={t('pages.recurringAlarms.stepAria', { field: label })}
            value={field.step}
            disabled={disabled}
            inputMode="numeric"
            placeholder={t('pages.recurringAlarms.stepPlaceholder')}
            onChange={(event) => onChange({ ...field, step: event.target.value.trim() })}
            dir="ltr"
          />
        ) : fieldKey === 'weekday' ? (
          <WeekdayPicker
            values={field.values}
            disabled={disabled}
            onChange={(values) => onChange({ ...field, values })}
          />
        ) : (
          <ValuesInput
            field={field}
            fieldKey={fieldKey}
            label={label}
            disabled={disabled}
            onChange={(values) => onChange({ ...field, values })}
          />
        )}
      </div>
    </fieldset>
  );
}

/** One row per rule: minute, hour, day, month and weekday, each either 「every」 or 「at」. */
export function RuleBuilder({
  rules,
  incomplete,
  disabled,
  onChange,
}: {
  readonly rules: readonly BuilderRule[];
  readonly incomplete: ReadonlyMap<number, readonly FieldKey[]>;
  readonly disabled: boolean;
  readonly onChange: (rules: readonly BuilderRule[]) => void;
}): ReactElement {
  const { t } = useTranslation();
  const replace = (index: number, rule: BuilderRule): void =>
    onChange(rules.map((existing, position) => (position === index ? rule : existing)));
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '3' })}>
      {rules.map((rule, index) => (
        <section
          // Rules have no identity of their own; a removed row shifts the rest up.
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the rule's identity in this editor.
          key={index}
          aria-label={t('pages.recurringAlarms.ruleTitle', { n: index + 1 })}
          className={css({ borderWidth: '1px', borderColor: 'border', borderRadius: 'md', padding: '3' })}
        >
          <div className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between' })}>
            <span className={css({ textStyle: 'label' })}>
              {t('pages.recurringAlarms.ruleTitle', { n: index + 1 })}
            </span>
            {rules.length > 1 ? (
              <IconButton
                variant="ghost"
                color="secondary"
                size="sm"
                disabled={disabled}
                label={t('pages.recurringAlarms.removeRule', { n: index + 1 })}
                icon={<TrashIcon />}
                onClick={() => onChange(rules.filter((_, position) => position !== index))}
              />
            ) : null}
          </div>
          <div
            className={css({
              display: 'grid',
              gap: '3',
              marginBlockStart: '2',
              gridTemplateColumns: 'repeat(auto-fill, minmax(9rem, 1fr))',
            })}
          >
            {FIELD_KEYS.map((fieldKey) => (
              <FieldEditor
                key={fieldKey}
                rule={rule}
                fieldKey={fieldKey}
                disabled={disabled}
                onChange={(field) => replace(index, { ...rule, [fieldKey]: field })}
              />
            ))}
          </div>
          {incomplete.has(index) ? (
            <p className={css({ textStyle: 'small', color: 'error-text', marginBlockStart: '2' })}>
              {t('pages.recurringAlarms.fieldIncomplete', {
                fields: (incomplete.get(index) ?? [])
                  .map((fieldKey) => t(`pages.recurringAlarms.field.${fieldKey}`))
                  .join(', '),
              })}
            </p>
          ) : null}
        </section>
      ))}
      <div>
        <Button
          variant="outline"
          color="secondary"
          size="sm"
          iconStart={<PlusIcon />}
          disabled={disabled || rules.length >= RULES_MAX}
          onClick={() => onChange([...rules, defaultBuilderRule()])}
        >
          {t('pages.recurringAlarms.addRule')}
        </Button>
      </div>
    </div>
  );
}
