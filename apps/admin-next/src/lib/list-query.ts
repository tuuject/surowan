import { useNavigate, useSearch } from '@tanstack/react-router';

export type ListQueryValues = Record<string, string>;

/** Keeps URL query values as untrusted strings; each page picks and validates its own fields. */
export function listQuerySearch(search: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(search).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function normalize(values: ListQueryValues): ListQueryValues {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]));
}

/**
 * Applied list conditions live in the URL. Only this hook's apply method writes
 * them, so a form can edit an independent draft without fetching or filtering.
 * Pagination hooks use the serialized applied value as their reset key.
 */
export function useListQuery<T extends ListQueryValues>(
  emptyValue: T,
): {
  readonly value: T;
  readonly resetKey: string;
  readonly apply: (next: T) => void;
} {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const keys = Object.keys(emptyValue);
  const next = Object.fromEntries(keys.map((key) => [key, typeof search[key] === 'string' ? search[key].trim() : '']));
  const value = normalize(next) as T;

  return {
    value,
    resetKey: JSON.stringify(value),
    apply: (next) => {
      const normalized = normalize(next);
      void navigate({
        search: ((previous: Record<string, unknown>) => {
          const updated = { ...previous };
          for (const key of keys) {
            delete updated[key];
          }
          for (const [key, item] of Object.entries(normalized)) {
            if (item.length > 0) {
              updated[key] = item;
            }
          }
          return updated;
        }) as never,
        replace: false,
      });
    },
  };
}

export function optionalQuery(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

export function chatQuery(value: string): string | undefined {
  return /^-?\d{1,19}$/.test(value) ? value : undefined;
}
