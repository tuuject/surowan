import { and, eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { invocationMessages, invocations, messages } from '../src/store/schema.ts';
import { fixture, replayError } from './replay-fixtures.ts';

test('scene guards report missing, unfinished, unconfigured, invalid and empty scenes without model calls', async () => {
  const f = await fixture();
  replayError(() => f.runner.inspect(999_999n), 'not_found');
  await expect(f.runner.run(999_999n, {}, new AbortController().signal)).rejects.toMatchObject({
    code: 'not_found',
    status: 404,
  });

  f.store.orm
    .update(invocations)
    .set({ state: 'running', finishedAt: null })
    .where(eq(invocations.id, f.seed.invocationA))
    .run();
  expect(f.runner.inspect(f.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_source_unfinished',
    message: 'Replay requires a finished invocation',
    prompt_overrides_available: false,
  });
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_source_unfinished' });
  f.store.orm
    .update(invocations)
    .set({ state: 'completed', finishedAt: '2026-09-10T08:00:06.000Z' })
    .where(eq(invocations.id, f.seed.invocationA))
    .run();

  // A chat the current configuration dropped, and a model it no longer routes.
  const current = f.configStore.current();
  f.configStore.publish({
    ...current,
    config: { ...current.config, telegram: { ...current.config.telegram, chats: [] } },
  });
  expect(f.runner.inspect(f.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_chat_unconfigured',
    message: 'The source chat is no longer configured',
  });
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_chat_unconfigured' });
  f.configStore.publish({
    ...current,
    config: { ...current.config, agent: { ...current.config.agent, model: 'retired-model' } },
  });
  expect(f.runner.inspect(f.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_model_unavailable',
    message: 'The current agent model is unavailable',
  });
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_model_unavailable' });
  f.configStore.publish(current);
  expect(f.faux.state.callCount).toBe(0);
});

test('a topic outside the current allowlist and an invalid or empty scene are refused before the model', async () => {
  const g = await fixture({ change: (config) => (config.telegram.chats[0]!.topic_ids = [7]) });
  expect(g.runner.inspect(g.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_topic_unconfigured',
    message: 'The source topic is no longer configured',
  });
  await expect(g.run()).rejects.toMatchObject({ code: 'replay_topic_unconfigured' });

  const f = await fixture();
  f.store.orm
    .update(invocationMessages)
    .set({ snapshotJson: '{' })
    .where(and(eq(invocationMessages.invocationId, f.seed.invocationA), eq(invocationMessages.section, 'new')))
    .run();
  expect(f.runner.inspect(f.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_scene_invalid',
  });
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_scene_invalid' });

  // No public message exists at the cutoff at all: there is nothing to replay.
  f.store.orm.delete(invocationMessages).run();
  f.store.orm.update(messages).set({ currentRevisionId: null }).run();
  f.store.orm.delete(messages).run();
  expect(f.runner.inspect(f.seed.invocationA)).toMatchObject({
    available: false,
    reason: 'replay_scene_unavailable',
  });
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_scene_unavailable' });
  expect(g.faux.state.callCount).toBe(0);
  expect(f.faux.state.callCount).toBe(0);
});
