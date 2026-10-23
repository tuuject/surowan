import { expect, test } from 'vitest';
import { SendInputSchema, SendReplyInputSchema } from '../src/capabilities/send-tool.ts';
import { createReplayTools } from '../src/orchestration/replay-tools.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { definition, replayInput, toolOf } from './replay-tools-fixtures.ts';

test('send synthesizes text, image, and sticker messages and preserves arguments', async () => {
  const replay = createReplayTools(
    replayInput({ tools: [definition('send', SendInputSchema)] }),
    emptySystemResources(),
  );
  const send = toolOf(replay.tools, 'send');
  const textResult = await send.execute('send-1', { kind: 'text', text: 'hello', reply_to_message_id: '42' });
  expect(textResult.content).toEqual([{ type: 'text', text: 'Sent Telegram message 1' }]);
  expect(textResult.details).toEqual({ telegramMessageId: '1' });
  const imageId = '00000000-0000-4000-8000-000000000000';
  const imageResult = await send.execute('send-2', { kind: 'image', image_generation_id: imageId, text: 'picture' });
  expect(imageResult.content).toEqual([{ type: 'text', text: 'Sent Telegram message 2' }]);
  const stickerResult = await send.execute('send-3', { kind: 'sticker', sticker_ref: 'stk_abc' });
  expect(stickerResult.details).toEqual({ telegramMessageId: '3' });
  // kind may be omitted for text, mirroring the production send semantics.
  await send.execute('send-4', { text: 'no kind' });
  expect(replay.outputs).toEqual([
    {
      tool_call_id: 'send-1',
      tool_name: 'send',
      arguments: { kind: 'text', text: 'hello', reply_to_message_id: '42' },
      reply_to_message_id: '42',
    },
    {
      tool_call_id: 'send-2',
      tool_name: 'send',
      arguments: { kind: 'image', image_generation_id: imageId, text: 'picture' },
      reply_to_message_id: null,
    },
    {
      tool_call_id: 'send-3',
      tool_name: 'send',
      arguments: { kind: 'sticker', sticker_ref: 'stk_abc' },
      reply_to_message_id: null,
    },
    { tool_call_id: 'send-4', tool_name: 'send', arguments: { text: 'no kind' }, reply_to_message_id: null },
  ]);
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'send-1', tool_name: 'send', mode: 'synthetic' },
    { tool_call_id: 'send-2', tool_name: 'send', mode: 'synthetic' },
    { tool_call_id: 'send-3', tool_name: 'send', mode: 'synthetic' },
    { tool_call_id: 'send-4', tool_name: 'send', mode: 'synthetic' },
  ]);
  await expect(send.execute('send-5', {})).rejects.toThrow('send input does not match its kind: kind:text needs text');
  await expect(send.execute('send-6', { kind: 'sticker', sticker_ref: 'stk_abc', text: 'caption' })).rejects.toThrow(
    'send input does not match its kind: a sticker cannot carry text',
  );
  await expect(send.execute('send-7', { kind: 'text', text: 'x'.repeat(5_000) })).rejects.toThrow(
    'send input does not match the tool schema',
  );
  expect(replay.outputs).toHaveLength(4);
});

test('send rejects repeated reply targets within the scene without recording another output', async () => {
  const registry = replayInput({ tools: [definition('send', SendInputSchema)] });
  const replay = createReplayTools(registry, emptySystemResources(), { replyMessageIds: new Set(['42', '43']) });
  const send = toolOf(replay.tools, 'send');
  await send.execute('first', { text: 'first answer', reply_to_message_id: '42' });
  await expect(send.execute('duplicate-text', { text: 'different answer', reply_to_message_id: '42' })).rejects.toThrow(
    'reply_already_sent',
  );
  await expect(
    send.execute('duplicate-sticker', { kind: 'sticker', sticker_ref: 'stk_test', reply_to_message_id: '42' }),
  ).rejects.toThrow('reply_already_sent');
  await send.execute('other', { text: 'another discussion', reply_to_message_id: '43' });
  await send.execute('no-reply', { text: 'independent completion' });
  expect(replay.outputs.map((output) => output.reply_to_message_id)).toEqual(['42', '43', null]);
  expect(replay.dispatches).toHaveLength(5);
  // A replay is an isolated experiment, not a new read of production delivery state.
  const separate = createReplayTools(registry, emptySystemResources());
  await toolOf(separate.tools, 'send').execute('fresh', { text: 'new scene', reply_to_message_id: '42' });
  expect(separate.outputs).toHaveLength(1);
});

test('the duplicate send guard rejects a repeated text or sticker within the scene', async () => {
  let rejections = 0;
  const registry = replayInput({
    tools: [definition('send', SendInputSchema), definition('send_reply', SendReplyInputSchema)],
  });
  const replay = createReplayTools(registry, emptySystemResources(), {
    allowReplyMessageMultipleTimes: true,
    replyMessageIds: new Set(['42']),
    duplicateSendGuard: { onRejected: () => (rejections += 1) },
  });
  const send = toolOf(replay.tools, 'send');
  const sendReply = toolOf(replay.tools, 'send_reply');
  await send.execute('first', { text: 'same', reply_to_message_id: '42' });
  // Kind defaults and ignored fields do not make a different message.
  await expect(
    send.execute('again', { kind: 'text', text: 'same', reply_to_message_id: '42', sticker_ref: 'unused' }),
  ).rejects.toThrow('send_duplicate');
  // Unattached right after it is the same content again; after another message it is not a repeat.
  await expect(send.execute('unattached-now', { text: 'same' })).rejects.toThrow('send_duplicate');
  await send.execute('sticker', { kind: 'sticker', sticker_ref: 'stk_abc' });
  await send.execute('unattached', { text: 'same' });
  await expect(
    sendReply.execute('reply', { parts: [{ text: 'new' }, { kind: 'sticker', sticker_ref: 'stk_abc' }] }),
  ).rejects.toThrow('send_duplicate');
  await expect(sendReply.execute('twice', { parts: [{ text: 'twin' }, { text: 'twin' }] })).rejects.toThrow(
    'send_duplicate',
  );
  expect(rejections).toBe(4);
  expect(replay.outputs.map((output) => output.tool_call_id)).toEqual(['first', 'sticker', 'unattached']);
  // Without the option every repeat is synthesized, as with the guard turned off in production.
  const unguarded = createReplayTools(registry, emptySystemResources());
  await toolOf(unguarded.tools, 'send').execute('one', { text: 'same' });
  await toolOf(unguarded.tools, 'send').execute('two', { text: 'same' });
  expect(unguarded.outputs).toHaveLength(2);
});

test('a reply-policy rejection burns the content for the rest of the scene, mirroring production', async () => {
  let rejections = 0;
  const registry = replayInput({
    tools: [definition('send', SendInputSchema), definition('send_reply', SendReplyInputSchema)],
  });
  const replay = createReplayTools(registry, emptySystemResources(), {
    replyMessageIds: new Set(['42', '43']),
    duplicateSendGuard: { onRejected: () => (rejections += 1) },
  });
  const send = toolOf(replay.tools, 'send');
  const sendReply = toolOf(replay.tools, 'send_reply');
  await send.execute('first', { text: 'first answer', reply_to_message_id: '42' });
  await expect(send.execute('blocked', { text: 'second take', reply_to_message_id: '42' })).rejects.toThrow(
    'reply_already_sent',
  );
  // Retargeting or omitting the reply target does not lift the rejection.
  await expect(send.execute('retarget', { text: 'second take', reply_to_message_id: '43' })).rejects.toThrow(
    'send_bypass',
  );
  await expect(send.execute('bare', { text: 'second take' })).rejects.toThrow('send_bypass');
  await expect(sendReply.execute('bundle', { parts: [{ text: 'second take' }, { text: 'coda' }] })).rejects.toThrow(
    'send_bypass',
  );
  await send.execute('fresh', { text: 'third take', reply_to_message_id: '43' });
  expect(rejections).toBe(3);
  expect(replay.outputs.map((output) => output.reply_to_message_id)).toEqual(['42', '43']);
  expect(replay.dispatches).toHaveLength(6);
});

test('an exact repeat of a published reply burns its content in the scene, mirroring production', async () => {
  const registry = replayInput({ tools: [definition('send', SendInputSchema)] });
  const replay = createReplayTools(registry, emptySystemResources(), {
    replyMessageIds: new Set(['42', '43']),
    duplicateSendGuard: { onRejected: () => {} },
  });
  const send = toolOf(replay.tools, 'send');
  await send.execute('first', { text: 'first answer', reply_to_message_id: '42' });
  await expect(send.execute('repeat', { text: 'first answer', reply_to_message_id: '42' })).rejects.toThrow(
    'send_duplicate',
  );
  await expect(send.execute('bare', { text: 'first answer' })).rejects.toThrow('send_bypass');
  expect(replay.outputs.map((output) => output.tool_call_id)).toEqual(['first']);
});

test('the last message re-aimed at another reply target is a duplicate in the scene, mirroring production', async () => {
  let rejections = 0;
  const registry = replayInput({
    tools: [definition('send', SendInputSchema), definition('send_reply', SendReplyInputSchema)],
  });
  const replay = createReplayTools(registry, emptySystemResources(), {
    replyMessageIds: new Set(['42', '43']),
    duplicateSendGuard: { onRejected: () => (rejections += 1) },
  });
  const send = toolOf(replay.tools, 'send');
  const sendReply = toolOf(replay.tools, 'send_reply');
  await send.execute('to-42', { text: 'not my field', reply_to_message_id: '42' });
  await expect(send.execute('to-43', { text: 'not my field', reply_to_message_id: '43' })).rejects.toThrow(
    'send_duplicate',
  );
  await expect(send.execute('bare', { text: 'not my field' })).rejects.toThrow('send_bypass');
  await expect(
    sendReply.execute('adjacent', { parts: [{ text: 'B' }, { text: 'B', parse_mode: 'MarkdownV2' }] }),
  ).rejects.toThrow('send_duplicate');
  await sendReply.execute('apart', { parts: [{ text: 'B' }, { text: 'C' }] });
  expect(rejections).toBe(3);
  expect(replay.outputs.map((output) => output.tool_call_id)).toEqual(['to-42', 'apart:1', 'apart:2']);
});

test('send allows repeated reply targets when configured without bypassing scene visibility', async () => {
  const replay = createReplayTools(
    replayInput({ tools: [definition('send', SendInputSchema)] }),
    emptySystemResources(),
    { allowReplyMessageMultipleTimes: true, replyMessageIds: new Set(['42']) },
  );
  const send = toolOf(replay.tools, 'send');
  await send.execute('first', { text: 'first answer', reply_to_message_id: '42' });
  await send.execute('second', { kind: 'sticker', sticker_ref: 'stk_test', reply_to_message_id: '42' });
  await expect(send.execute('invisible', { text: 'not visible', reply_to_message_id: '43' })).rejects.toThrow(
    'reply_to_message_id is not visible',
  );
  expect(replay.outputs.map((output) => output.reply_to_message_id)).toEqual(['42', '42']);
  expect(replay.dispatches).toHaveLength(2);
});

test('send_reply synthesizes one send output per part and replies with the first part only', async () => {
  const replay = createReplayTools(
    replayInput({ tools: [definition('send', SendInputSchema), definition('send_reply', SendReplyInputSchema)] }),
    emptySystemResources(),
    { replyMessageIds: new Set(['42']), maxTextLength: 20 },
  );
  const sendReply = toolOf(replay.tools, 'send_reply');
  const result = await sendReply.execute('multi', {
    reply_to_message_id: '42',
    parts: [{ kind: 'sticker', sticker_ref: 'stk_abc' }, { text: 'first line' }, { text: 'second line' }],
  });
  expect(result.content).toEqual([{ type: 'text', text: 'Sent 3 Telegram messages in order: 1, 2, 3' }]);
  expect(result.details).toEqual({ telegramMessageIds: ['1', '2', '3'] });
  expect(replay.outputs).toEqual([
    {
      tool_call_id: 'multi:1',
      tool_name: 'send',
      arguments: { kind: 'sticker', sticker_ref: 'stk_abc', reply_to_message_id: '42' },
      reply_to_message_id: '42',
    },
    { tool_call_id: 'multi:2', tool_name: 'send', arguments: { text: 'first line' }, reply_to_message_id: null },
    { tool_call_id: 'multi:3', tool_name: 'send', arguments: { text: 'second line' }, reply_to_message_id: null },
  ]);
  expect(replay.dispatches).toEqual([{ tool_call_id: 'multi', tool_name: 'send_reply', mode: 'synthetic' }]);
  // A bad later part rejects the whole reply before any output is recorded.
  await expect(sendReply.execute('too-long', { parts: [{ text: 'fine' }, { text: 'x'.repeat(21) }] })).rejects.toThrow(
    'send_reply part 2 text exceeds the current configured length limit',
  );
  await expect(sendReply.execute('one-part', { parts: [{ text: 'alone' }] })).rejects.toThrow(
    'send_reply input does not match the tool schema',
  );
  // The first part spends the reply target like a send would.
  await expect(
    sendReply.execute('again', { reply_to_message_id: '42', parts: [{ text: 'a' }, { text: 'b' }] }),
  ).rejects.toThrow('reply_already_sent');
  expect(replay.outputs).toHaveLength(3);
});
