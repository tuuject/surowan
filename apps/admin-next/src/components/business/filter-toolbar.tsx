import { Select } from '@tuuject/koi-react/select';
import { Search, X } from 'lucide-react';
import type React from 'react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Filter toolbar building blocks. Semantics per field type: text filters are
 * explicit (type → press Search / Enter, or the X to clear the *applied*
 * filter), select filters apply immediately on change. Layout wraps
 * automatically on narrow screens.
 */

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export function FilterToolbar({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

export interface TextFilterProps {
  readonly value: string | undefined;
  readonly placeholder: string;
  /** Called with the trimmed draft when the user submits (Enter or search button). */
  readonly onCommit: (value: string) => void;
  /** Called when the user clears the filter; resets pagination via the page's filters state. */
  readonly onClear: () => void;
  readonly className?: string;
  readonly widthClassName?: string;
}

export function TextFilter({
  value,
  placeholder,
  onCommit,
  onClear,
  className,
  widthClassName = 'w-56',
}: TextFilterProps): React.ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value ?? '');

  useEffect(() => {
    setDraft(value ?? '');
  }, [value]);

  const commit = (): void => {
    onCommit(draft.trim());
  };
  const clear = (): void => {
    setDraft('');
    onClear();
  };

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Input
        value={draft}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cn('h-8', widthClassName)}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit();
          }
        }}
      />
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        onClick={commit}
        aria-label={t('layout.business.applyFilter')}
      >
        <Search />
      </Button>
      {draft.length > 0 ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={clear}
          aria-label={t('layout.business.clearFilter')}
        >
          <X />
        </Button>
      ) : null}
    </div>
  );
}

const ALL_OPTION_VALUE = '__all__';

export interface SelectFilterProps<T extends string> {
  readonly value: T | undefined;
  readonly placeholder: string;
  /** Called immediately when the selection changes; undefined clears the filter. */
  readonly onChange: (value: T | undefined) => void;
  readonly options: readonly FilterOption[];
  readonly className?: string;
}

export function SelectFilter<T extends string>({
  value,
  placeholder,
  onChange,
  options,
  className,
}: SelectFilterProps<T>): React.ReactElement {
  const { t } = useTranslation();
  const id = useId();
  return (
    <label htmlFor={id} className={cn('flex items-center gap-1.5', className)}>
      <span aria-hidden="true" className="text-muted-foreground shrink-0 text-xs">
        {placeholder}
      </span>
      <Select
        id={id}
        size="sm"
        className="w-44"
        aria-label={placeholder}
        value={value ?? ALL_OPTION_VALUE}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === ALL_OPTION_VALUE ? undefined : (next as T));
        }}
      >
        <option value={ALL_OPTION_VALUE}>{t('layout.business.all')}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </label>
  );
}
