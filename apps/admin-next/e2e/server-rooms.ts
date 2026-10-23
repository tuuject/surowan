/**
 * The room runtime the playground specs drive: a fake model provider so a
 * Release can be observed end to end without a network, plus the scripted turns
 * a spec installs right before it releases a hold.
 */
import { fauxAssistantMessage, fauxToolCall, type FauxProviderHandle } from '@earendil-works/pi-ai';
import type { CoreRuntime } from '../../../src/orchestration/runtime.ts';

/**
 * What the room runtime's fake model does on its next turns. A spec scripts it
 * before releasing a hold, so the run's output is deterministic without a real
 * provider or network: `{ send }` publishes one message and continues,
 * `{ text }` ends the round without publishing.
 */
export type PlaygroundModelStep = { readonly send?: string; readonly text?: string };

/** Rooms the playground specs address; the panel API owns their ids. */
export type PlaygroundSeed = { readonly rooms: readonly { readonly id: string; readonly title: string }[] };

let playgroundSeed: PlaygroundSeed = { rooms: [] };
let roomRuntime: CoreRuntime | null = null;
let roomFaux: FauxProviderHandle | null = null;
let roomSchedulerStarted = false;
let roomScriptVersion = 0;

export function setPlaygroundSeed(rooms: PlaygroundSeed['rooms']): void {
  playgroundSeed = { rooms };
}

export function playgroundSeedPayload(): PlaygroundSeed {
  return playgroundSeed;
}

/** The fake model is installed before the runtime it belongs to is assembled. */
export function setRoomFaux(faux: FauxProviderHandle): void {
  roomFaux = faux;
}

export function setRoomRuntime(runtime: CoreRuntime): void {
  roomRuntime = runtime;
}

/** Model turns the fake provider has served, as exposed to the specs. */
export function roomModelCalls(): number {
  return roomFaux?.state.callCount ?? 0;
}

/**
 * Starts the room scheduler on first use. Every spec file gets its own E2E
 * server over the shared synthetic fixture; a scheduler that ran from boot
 * would process the fixture's seeded alarms and contexts for specs that only
 * render pages. Files that release a room explicitly opt in here.
 */
export function wakeRoomScheduler(): void {
  const runtime = roomRuntime;
  if (runtime === null) {
    return;
  }
  if (!roomSchedulerStarted) {
    roomSchedulerStarted = true;
    runtime.scheduler.start();
  }
  runtime.scheduler.wake();
}

/** Nudges the scheduler without starting it: task changes must not opt a spec in. */
export function nudgeRoomScheduler(): void {
  roomRuntime?.scheduler.wake();
}

/** Turns the spec's steps into model turns; a trailing turn always ends the round. */
export function setPlaygroundModel(steps: readonly PlaygroundModelStep[]): void {
  const faux = roomFaux;
  if (faux === null) {
    throw new Error('the room runtime is not assembled yet');
  }
  // Tool-call ids must be unique across the whole database: the audit table
  // keys on them, and two runs reusing one id would collide there.
  roomScriptVersion += 1;
  const responses = steps.map((step, index) =>
    step.send === undefined
      ? () => fauxAssistantMessage(step.text ?? '')
      : () =>
          fauxAssistantMessage(
            fauxToolCall(
              'send',
              { kind: 'text', text: step.send ?? '' },
              { id: `room-send-${roomScriptVersion}-${index + 1}` },
            ),
            { stopReason: 'toolUse' },
          ),
  );
  responses.push(() => fauxAssistantMessage(''));
  faux.setResponses(responses);
}

/** Stops the scheduler, but only if a spec ever started it. */
export async function stopRoomScheduler(): Promise<void> {
  if (roomSchedulerStarted) {
    await roomRuntime?.scheduler.stop(1_000);
  }
}
