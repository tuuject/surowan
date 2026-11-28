import { imageSchema } from '@surowan/image-service';
import { expect, test } from 'vitest';
import { createExecuteTool } from '../../src/capabilities/execute-tool.ts';
import imagePlugin from '../../src/plugins/image/index.ts';
import { longTasks, toolCalls } from '../../src/store/schema/index.ts';
import { createToolAudit } from '../../src/store/tool-audit.ts';
import {
  fakeScope,
  fixture,
  generationIdOf,
  installImageAgentHooks,
  type ImageAgentFixture,
  waitFor,
} from './agent-fixtures.ts';

// ---------------------------------------------------------------------------
// The per-invocation image cap bounds generations still in progress, not the
// ones an invocation ever created. An invocation is extended by follow-up
// messages, so one user editing a picture round after round inside it must
// never run out; only a burst of parallel submits is held back, and the
// refusal tells the model to queue the rest instead of reporting a spent
// budget to the user.
// ---------------------------------------------------------------------------

installImageAgentHooks();

function generateTool(fixtureRef: ImageAgentFixture) {
  const audit = createToolAudit(fixtureRef.store, 7n);
  const scope = { ...fakeScope(fixtureRef.pluginBridge), audit };
  return createExecuteTool({ audit, capabilities: imagePlugin.capabilities?.(scope) ?? [] });
}

function submit(execute: ReturnType<typeof generateTool>, callId: string, prompt: string) {
  return execute.execute(callId, { action: 'call', tool: 'image_generate', input: { prompt } });
}

function imageGenerateRows(fixtureRef: ImageAgentFixture) {
  return fixtureRef.store.orm
    .select()
    .from(toolCalls)
    .all()
    .filter((row) => row.toolName === 'image_generate');
}

function taskStates(fixtureRef: ImageAgentFixture) {
  return fixtureRef.store.orm
    .select({ state: longTasks.state, invocationId: longTasks.createdByInvocationId })
    .from(longTasks)
    .all();
}

async function settled(fixtureRef: ImageAgentFixture, generationId: string) {
  return waitFor(() => {
    const task = fixtureRef.tasks
      .scoped('image', 42n)
      .list()
      .find((entry) => generationIdOf(entry.payload) === generationId);
    return task !== undefined && task.state !== 'waiting' ? task.state : null;
  });
}

test('one invocation can edit a picture round after round past the in-progress cap', async () => {
  const fixtureRef = await fixture();
  const execute = generateTool(fixtureRef);

  // The incident: five revisions inside one long invocation; the 4th and 5th
  // used to be refused although every earlier generation had already finished.
  for (let round = 1; round <= 5; round += 1) {
    const result = await submit(execute, `round-${round}`, `a quiet harbor at dusk, revision ${round}`);
    const envelope = JSON.parse(result.content.find((entry) => entry.type === 'text')!.text);
    const generationId = /Generation (\S+) submitted/.exec(envelope.text)?.[1];
    expect(generationId).toBeDefined();
    expect(await settled(fixtureRef, generationId!)).toBe('completed');
  }

  expect(fixtureRef.calls).toHaveLength(5);
  expect(fixtureRef.store.orm.select().from(imageSchema.generations).all()).toHaveLength(5);
  expect(taskStates(fixtureRef)).toEqual(Array.from({ length: 5 }, () => ({ state: 'completed', invocationId: 7n })));
  expect(
    imageGenerateRows(fixtureRef).map(({ state, sideEffect, errorCode }) => ({ state, sideEffect, errorCode })),
  ).toEqual(Array.from({ length: 5 }, () => ({ state: 'success', sideEffect: true, errorCode: null })));
});

test('a fourth parallel submit is refused as a concurrency limit and fits once one settles', async () => {
  const releases: Array<() => void> = [];
  const fixtureRef = await fixture(
    [],
    (_index, signal) =>
      new Promise<void>((resolve, reject) => {
        releases.push(resolve);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const execute = generateTool(fixtureRef);

  const accepted: string[] = [];
  for (let index = 1; index <= 3; index += 1) {
    const result = await submit(execute, `parallel-${index}`, `a lighthouse, variant ${index}`);
    const envelope = JSON.parse(result.content.find((entry) => entry.type === 'text')!.text);
    accepted.push(/Generation (\S+) submitted/.exec(envelope.text)![1]!);
  }
  expect(taskStates(fixtureRef).map(({ state }) => state)).toEqual(['waiting', 'waiting', 'waiting']);

  let refusal: unknown;
  try {
    await submit(execute, 'parallel-4', 'a lighthouse, variant 4');
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(Error);
  const message = (refusal as Error).message;
  // The model must learn this is a wait, not a spent budget, and how to go on.
  expect(message).toMatch(/3 image generations .* still in progress/);
  expect(message).toMatch(/not a used-up quota/);
  // Nothing waits on the model's behalf: it has to resubmit the request itself.
  expect(message).toMatch(/Nothing was submitted or queued/);
  expect(message).toMatch(/call image_generate again/);
  expect(message).toMatch(/completion receipt/);
  expect(message).not.toMatch(/quota of 3 per invocation reached/);

  // Refused before anything paid was created: no generation row, no task.
  expect(fixtureRef.store.orm.select().from(imageSchema.generations).all()).toHaveLength(3);
  expect(taskStates(fixtureRef)).toHaveLength(3);
  const refused = imageGenerateRows(fixtureRef).find((row) => row.toolCallId === 'parallel-4:image_generate');
  expect(refused).toMatchObject({ state: 'error', sideEffect: true, errorCode: 'image_generate_quota_exceeded' });

  // The worker runs one round at a time; releasing it settles the first one.
  await waitFor(() => releases[0]);
  releases[0]!();
  expect(await settled(fixtureRef, accepted[0]!)).toBe('completed');

  const retried = await submit(execute, 'parallel-4-retry', 'a lighthouse, variant 4');
  expect(retried.content.find((entry) => entry.type === 'text')!.text).toContain('submitted');
  expect(taskStates(fixtureRef).map(({ state }) => state)).toEqual(['completed', 'waiting', 'waiting', 'waiting']);

  // Drain the held rounds so teardown does not race in-flight work.
  for (let index = 1; index <= 3; index += 1) {
    await waitFor(() => releases[index]);
    releases[index]!();
  }
  await waitFor(() => (taskStates(fixtureRef).every(({ state }) => state === 'completed') ? true : null));
  expect(fixtureRef.calls).toHaveLength(4);
});
