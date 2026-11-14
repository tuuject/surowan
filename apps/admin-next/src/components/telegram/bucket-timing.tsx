import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Field } from '@tuuject/koi-react/field';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel } from '@/components/layout/panel';
import {
  type BucketTiming,
  type BucketTimingUpdate,
  putTelegramBucketTiming,
  type TelegramView,
} from '@/lib/api/telegram.ts';
import { errorMessage } from '@/lib/errors';
import { telegramQuery } from '@/lib/queries';
import { useProviderWrite } from '@/lib/use-provider-write';

type TimingKey = keyof BucketTiming;

/** Same bounds as the configuration schema; the server still validates the whole file. */
const MAX_SECONDS = 300;

const FIELDS: readonly { readonly key: TimingKey; readonly id: 'window' | 'max' | 'bump' }[] = [
  { key: 'bucket_window_seconds', id: 'window' },
  { key: 'bucket_max_seconds', id: 'max' },
  { key: 'bucket_bump_seconds', id: 'bump' },
];

type Draft = Readonly<Record<TimingKey, string>>;
type DraftError = 'integer' | 'range' | 'belowWindow';

function draftOf(saved: BucketTiming): Draft {
  return {
    bucket_window_seconds: String(saved.bucket_window_seconds),
    bucket_max_seconds: saved.bucket_max_seconds === null ? '' : String(saved.bucket_max_seconds),
    bucket_bump_seconds: String(saved.bucket_bump_seconds),
  };
}

/** Numbers are edited as text so a half-typed value is not coerced away; only the ceiling may be empty. */
function parseSeconds(text: string, nullable: boolean): number | null | DraftError {
  const trimmed = text.trim();
  if (trimmed === '') {
    return nullable ? null : 'integer';
  }
  if (!/^\d+$/.test(trimmed)) {
    return 'integer';
  }
  const value = Number(trimmed);
  return value > MAX_SECONDS ? 'range' : value;
}

function parseDraft(
  draft: Draft,
  saved: BucketTiming,
): { readonly changes: BucketTimingUpdate; readonly errors: Partial<Record<TimingKey, DraftError>> } {
  const changes: Record<string, number | null> = {};
  const errors: Partial<Record<TimingKey, DraftError>> = {};
  const values: Partial<Record<TimingKey, number | null>> = {};
  for (const { key } of FIELDS) {
    const value = parseSeconds(draft[key], key === 'bucket_max_seconds');
    if (typeof value === 'string') {
      errors[key] = value;
      continue;
    }
    values[key] = value;
    if (value !== saved[key]) {
      changes[key] = value;
    }
  }
  const window = values.bucket_window_seconds;
  const max = values.bucket_max_seconds;
  if (typeof window === 'number' && typeof max === 'number' && max < window) {
    errors.bucket_max_seconds = 'belowWindow';
  }
  return { changes: changes as BucketTimingUpdate, errors };
}

function useBucketTimingSave() {
  const queryClient = useQueryClient();
  const write = useProviderWrite();
  return useMutation({
    mutationFn: ({ update, revision }: { readonly update: BucketTimingUpdate; readonly revision: string }) =>
      putTelegramBucketTiming(update, revision),
    onSuccess: ({ apply, ...view }) => {
      queryClient.setQueryData(telegramQuery.queryKey, view);
      write.succeeded(apply);
    },
    onError: (error) => {
      write.failed(error);
      // A revision conflict means this view's If-Match is stale.
      void queryClient.invalidateQueries({ queryKey: telegramQuery.queryKey });
    },
  });
}

/**
 * How long Telegram messages collect before the agent sees them. Saving applies
 * to the next batch; a batch already collecting keeps its own timing.
 */
export function BucketTimingPanel({ view }: { readonly view: TelegramView }): ReactElement {
  const { t } = useTranslation();
  // Owned above the form: a save re-mounts the form with the new saved values,
  // and a failed save's message must survive that.
  const save = useBucketTimingSave();
  const saved = view.bucket_timing.saved;
  return (
    <Panel title={t('pages.telegram.bucketTitle')} description={t('pages.telegram.bucketDescription')}>
      {/* Re-mount only when the saved timing changes, so a token save or a status poll keeps the draft. */}
      <BucketTimingForm
        key={JSON.stringify(saved)}
        revision={view.revision}
        saved={saved}
        active={view.bucket_timing.active}
        save={save}
      />
    </Panel>
  );
}

function BucketTimingForm({
  revision,
  saved,
  active,
  save,
}: {
  readonly revision: string;
  readonly saved: BucketTiming;
  readonly active: BucketTiming;
  readonly save: ReturnType<typeof useBucketTimingSave>;
}): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved));
  const parsed = parseDraft(draft, saved);
  const changed = Object.keys(parsed.changes).length;
  const invalid = Object.keys(parsed.errors).length > 0;
  const display = (key: TimingKey, value: number | null): string =>
    value === null && key === 'bucket_max_seconds' ? t('pages.telegram.bucketMaxFollowsWindow') : String(value);
  const status = invalid
    ? t('pages.telegram.bucketInvalid')
    : changed === 0
      ? t('pages.telegram.bucketUnchanged')
      : t('pages.telegram.bucketPending', { count: changed });

  return (
    <form
      noValidate
      className={css({ display: 'flex', flexDirection: 'column', gap: '5', maxWidth: '480px' })}
      onSubmit={(event) => {
        event.preventDefault();
        if (changed > 0 && !invalid && !save.isPending) {
          save.mutate({ update: parsed.changes, revision });
        }
      }}
    >
      <fieldset
        disabled={save.isPending}
        className={css({ display: 'flex', flexDirection: 'column', gap: '5', margin: '0', padding: '0', border: '0' })}
      >
        {FIELDS.map(({ key, id }) => {
          const error = parsed.errors[key];
          return (
            <div key={key} className={css({ display: 'flex', flexDirection: 'column', gap: '1' })}>
              <Field
                label={t(`pages.telegram.bucketFields.${id}.label`)}
                help={t(`pages.telegram.bucketFields.${id}.help`)}
                error={
                  error === undefined ? undefined : t(`pages.telegram.bucketErrors.${error}`, { max: MAX_SECONDS })
                }
              >
                <Input
                  className={css({ maxWidth: '240px' })}
                  inputMode="numeric"
                  placeholder={key === 'bucket_max_seconds' ? t('pages.telegram.bucketMaxFollowsWindow') : undefined}
                  value={draft[key]}
                  onChange={(event) => {
                    const text = event.target.value;
                    setDraft((previous) => ({ ...previous, [key]: text }));
                  }}
                  dir="ltr"
                />
              </Field>
              {saved[key] === active[key] ? null : (
                <p role="status" className={css({ margin: '0', textStyle: 'small', color: 'warning-text' })}>
                  {t('pages.telegram.bucketRunning', { value: display(key, active[key]) })}
                </p>
              )}
            </div>
          );
        })}
      </fieldset>
      <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
        <Button
          type="submit"
          disabled={changed === 0 || invalid}
          loading={save.isPending}
          loadingLabel={t('pages.telegram.saving')}
        >
          {t('pages.telegram.bucketSave')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          color="secondary"
          disabled={changed === 0 || save.isPending}
          onClick={() => {
            save.reset();
            setDraft(draftOf(saved));
          }}
        >
          {t('pages.telegram.bucketDiscard')}
        </Button>
        <span role="status" className={css({ color: 'text-muted' })}>
          {status}
        </span>
      </div>
      {save.isError ? (
        <p role="alert" className={css({ margin: '0', color: 'error-fg', overflowWrap: 'anywhere' })}>
          {errorMessage(save.error)}
        </p>
      ) : null}
    </form>
  );
}
