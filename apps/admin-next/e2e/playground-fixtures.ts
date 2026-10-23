import type { APIRequestContext } from '@playwright/test';
import { adminUrl } from './helpers.ts';

export interface InvocationPayload {
  readonly id: string;
  readonly state: string;
}

/** Polls one room's invocation list until the newest run reaches a terminal state. */
export async function waitForRun(request: APIRequestContext, roomId: string): Promise<InvocationPayload> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const listed = (await (
      await request.get(await adminUrl(`/api/playground/rooms/${roomId}/invocations`))
    ).json()) as { items: InvocationPayload[] };
    const latest = listed.items[0];
    if (latest !== undefined && !['queued', 'running'].includes(latest.state)) {
      return latest;
    }
    if (Date.now() > deadline) {
      throw new Error(`the room run did not settle: ${JSON.stringify(latest)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export interface SeedPayload {
  readonly rooms: readonly { readonly id: string; readonly title: string }[];
}

export function roomAt(seed: SeedPayload, index: number): { readonly id: string; readonly title: string } {
  const room = seed.rooms[index];
  if (room === undefined) {
    throw new Error(`the E2E seed has no room at index ${index}`);
  }
  return room;
}
