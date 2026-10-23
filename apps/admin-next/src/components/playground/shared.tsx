import type React from 'react';
import { useRef } from 'react';
import { ApiError } from '@/lib/api/core.ts';

/**
 * One request key per payload. Sending the same payload again reuses its key,
 * so a lost response replays the original result; any other payload gets a
 * fresh key, so an edited retry is never refused as a conflict. Keys are
 * opaque: nothing a user typed becomes part of one.
 */
export function usePayloadKey(scope: string): { keyFor: (payload: unknown) => string; settle: () => void } {
  const current = useRef<{ readonly signature: string; readonly key: string } | null>(null);
  return {
    keyFor: (payload: unknown): string => {
      const signature = JSON.stringify(payload);
      if (current.current?.signature !== signature) {
        current.current = { signature, key: `${scope}-${crypto.randomUUID()}` };
      }
      return current.current.key;
    },
    settle: (): void => {
      current.current = null;
    },
  };
}

/**
 * Whether a failed write may still have happened. A 4xx answer is the server
 * refusing before it wrote; a network failure or a 5xx leaves it unknown.
 */
export function outcomeUnknown(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

export function StatusPill({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | number;
}): React.ReactElement {
  return (
    <span className="text-muted-foreground text-xs">
      {label}: <span className="text-foreground font-medium">{value}</span>
    </span>
  );
}

/** The message a send carries; exactly what its request key is bound to. */
export interface MessagePayload {
  readonly sender_id: string;
  readonly text: string;
  readonly reply_to_seq: string | null;
  readonly asset_ids: readonly string[];
}
