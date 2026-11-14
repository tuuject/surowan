import { useQuery } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { Field } from '@tuuject/koi-react/field';
import { SearchIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement, ReactNode } from 'react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListFilterCard } from '@/components/business/list-page';
import { ResetIcon } from '@/components/icons';
import { memoryChatsQuery } from '@/lib/queries';

export type QueryFormValues = Record<string, string>;

/** What `chatQuery` accepts, as an HTML `pattern` (implicitly anchored). */
const CHAT_ID_PATTERN = '\\s*-?\\d{1,19}\\s*';

export interface QueryFormRender<T extends QueryFormValues> {
  readonly draft: T;
  readonly change: (patch: Partial<T>) => void;
}

interface ListSearchFormProps<T extends QueryFormValues> {
  /** Normalized conditions currently applied by the URL and the list query. */
  readonly value: T;
  readonly emptyValue: T;
  readonly onSearch: (value: T) => void;
  readonly activeCount?: number;
  readonly children: (state: QueryFormRender<T>) => ReactNode;
  readonly renderSubmitAndResetButton?: ({ onReset }: { onReset: () => void }) => ReactNode;
}

function normalizeValues<T extends QueryFormValues>(value: T): T {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item.trim()])) as T;
}

function valueKey(value: QueryFormValues): string {
  return JSON.stringify(normalizeValues(value));
}

/**
 * Order-management query form: edits stay in a draft until Search or Enter.
 * URL changes made by this form do not overwrite a newer draft; Back/Forward,
 * deep links and sidebar navigation do replace the draft with the applied URL.
 */
export function ListSearchForm<T extends QueryFormValues>({
  value,
  emptyValue,
  onSearch,
  activeCount,
  children,
  renderSubmitAndResetButton,
}: ListSearchFormProps<T>): ReactElement {
  const { t } = useTranslation();
  const normalizedValue = normalizeValues(value);
  const [draft, setDraft] = useState<T>(normalizedValue);
  const pushedKey = useRef(valueKey(normalizedValue));
  const [seenKey, setSeenKey] = useState(valueKey(normalizedValue));
  const appliedKey = valueKey(normalizedValue);

  if (appliedKey !== seenKey) {
    setSeenKey(appliedKey);
    if (appliedKey !== pushedKey.current) {
      // Acknowledge an external location too: revisiting an older own push via
      // Forward is still an external change and must restore that URL's draft.
      pushedKey.current = appliedKey;
      setDraft(normalizedValue);
    }
  }

  const apply = (next: T): void => {
    const normalized = normalizeValues(next);
    setDraft(normalized);
    pushedKey.current = valueKey(normalized);
    onSearch(normalized);
  };

  const count = activeCount ?? Object.values(normalizedValue).filter((item) => item.length > 0).length;

  const onReset = () => apply(emptyValue);

  return (
    <ListFilterCard activeCount={count}>
      <form
        className={css({
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6',
          paddingBlockStart: { base: '3', md: '0' },
          paddingInline: { base: '5', md: '0' },
          paddingBlockEnd: { base: '5', md: '0' },
        })}
        onSubmit={(event) => {
          event.preventDefault();
          apply(draft);
        }}
      >
        <div
          className={css({
            containerType: 'inline-size',
            flex: '1 1 480px',
            minWidth: '0',
          })}
        >
          <div
            className={css({
              display: 'grid',
              gap: '4',
              gridTemplateColumns: '1fr',
              '@container (min-width: 480px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
              '@container (min-width: 720px)': { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
              '@container (min-width: 1200px)': { gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' },
            })}
          >
            {children({
              draft,
              change: (patch) => setDraft((previous) => ({ ...previous, ...patch })),
            })}
          </div>
        </div>
        <div
          className={css({
            display: 'flex',
            flex: 'none',
            gap: '2',
            marginInlineStart: 'auto',
            paddingTop: '26px',
          })}
        >
          {renderSubmitAndResetButton ? (
            renderSubmitAndResetButton({ onReset })
          ) : (
            <>
              <Button type="submit" iconStart={<SearchIcon />}>
                {t('layout.koi.search')}
              </Button>
              <Button type="button" variant="ghost" color="secondary" iconStart={<ResetIcon />} onClick={onReset}>
                {t('layout.business.reset')}
              </Button>
            </>
          )}
        </div>
      </form>
    </ListFilterCard>
  );
}

interface QueryTextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly type?: 'text' | 'date' | 'number';
  readonly inputMode?: 'numeric' | 'text';
}

export function QueryTextField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  inputMode,
}: QueryTextFieldProps): ReactElement {
  return (
    <Field label={label} className={css({ minWidth: '0' })}>
      <Input
        type={type}
        aria-label={label}
        {...(placeholder === undefined ? {} : { placeholder })}
        {...(inputMode === undefined ? {} : { inputMode })}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        dir="auto"
      />
    </Field>
  );
}

export interface QuerySelectOption {
  readonly value: string;
  readonly label: string;
}

export function QuerySelectField({
  label,
  value,
  onChange,
  options,
  children,
  showAll = true,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options?: readonly QuerySelectOption[];
  readonly children?: ReactNode;
  readonly showAll?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Field label={label} className={css({ minWidth: '0' })}>
      <Select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {showAll ? <option value="">{t('layout.business.all')}</option> : null}
        {options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {children}
      </Select>
    </Field>
  );
}

/** A draft-only native combobox; selecting a suggestion never applies the query. */
export function ChatFilter({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const listId = useId();
  const chats = useQuery(memoryChatsQuery);
  const label = t('layout.business.chat');

  return (
    <Field label={label} className={css({ minWidth: '0' })}>
      <Input
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-controls={listId}
        list={listId}
        placeholder={t('layout.business.chatNameOrId')}
        // The lists filter by numeric Chat ID only. Anything else would stay in
        // the URL and the form as a condition the request silently drops, so
        // the browser refuses to submit it instead.
        pattern={CHAT_ID_PATTERN}
        title={t('layout.business.chatIdRequired')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        dir="auto"
      />
      <datalist id={listId}>
        {(chats.data?.items ?? []).map((chat) => (
          <option
            key={chat.telegram_chat_id}
            value={chat.telegram_chat_id}
            label={[chat.title ?? chat.telegram_chat_id, chat.type, chat.username === null ? null : `@${chat.username}`]
              .filter((part) => part !== null)
              .join(t('common.separator'))}
          />
        ))}
      </datalist>
    </Field>
  );
}
