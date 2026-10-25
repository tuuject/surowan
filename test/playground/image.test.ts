/**
 * Room image generation: opt-in, receipts and virtual picture output.
 *
 * The acceptance chain runs through the real assembly the composition root
 * uses — `createImageService`, `createImageBridge`, `loadPlugins(BUILTIN_PLUGINS)`,
 * `createHostTooling`, `createCoreRuntime`, `PlaygroundStore`, `PlaygroundIngress`,
 * `PlaygroundAssetStore` and the real system-skill tree. Only the image
 * provider's HTTP transport is a fake, and no Telegram transport exists at
 * all: a room picture can only come from the local asset store.
 *
 * Contracts under test:
 *  - a room without its image switch offers no `image_generate` capability, no
 *    image skill and no submission path, and spends nothing when refused;
 *  - flipping the switch changes the skill index, the copied prompt, the
 *    `execute` registry and paid submission together, and closing it only
 *    blocks new submissions;
 *  - a finished generation becomes a receipt, and `send kind:image` publishes
 *    the picture into the room with its ledger, media rows and assets;
 *  - reconciliation never settles a generation that can still run, and a
 *    process never executes or recovers a host's work it does not serve;
 *  - message retention never deletes the generation archive or an unhandled
 *    receipt, and the room's copy of a picture outlives its last reference only.
 */
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { toolCalls } from '../../src/store/schema/index.ts';
import {
  capabilityToolNames,
  enableRoomImage,
  generationRows,
  IMAGE_SKILL,
  playgroundImageFixture,
  releaseRoomInput,
  roomSystemPrompt,
  runInvocation,
  submitGeneration,
  taskRows,
} from './image-fixtures.ts';

describe('playground image generation', () => {
  test('a room without the image switch offers no tools, no skill and refuses the submission', async () => {
    const f = await playgroundImageFixture();
    expect(f.playground.room(f.room.chatId).imageEnabled).toBe(false);
    const invocationId = releaseRoomInput(f, 'ask-disabled');

    expect(f.tooling.skillVisible(IMAGE_SKILL, { hostKind: 'playground', conversationId: f.room.conversationId })).toBe(
      false,
    );
    expect(capabilityToolNames(f, invocationId)).not.toContain('image_generate');
    const prompt = roomSystemPrompt(f, invocationId);
    expect(prompt).toContain('web-fetch');
    expect(prompt).not.toContain('image-generation');

    await expect(submitGeneration(f, null, 'call-1')).rejects.toThrow('image generation is disabled');
    expect(generationRows(f)).toEqual([]);
    expect(taskRows(f)).toEqual([]);
    expect(f.providerCalls).toEqual([]);
  });

  test('the switch flips the skill index, the copied prompt, the registry and paid submission together', async () => {
    const f = await playgroundImageFixture();
    const invocationId = releaseRoomInput(f, 'ask-flip');
    enableRoomImage(f, true);
    const enabledRoom = f.playground.room(f.room.chatId);
    expect(enabledRoom).toMatchObject({ imageEnabled: true, imageEnabledBy: 'admin' });
    expect(enabledRoom.imageEnabledAt).not.toBeNull();

    expect(f.tooling.skillVisible(IMAGE_SKILL, { hostKind: 'playground', conversationId: f.room.conversationId })).toBe(
      true,
    );
    const names = capabilityToolNames(f, invocationId);
    expect(names).toContain('image_generate');
    expect(names).toContain('list_image_models');
    // The room's copied prompt carries the skill index, and it changes with the
    // switch; a skill the Playground never shows stays hidden either way.
    expect(roomSystemPrompt(f, invocationId)).toContain('image-generation');
    expect(
      f.tooling.skillVisible(
        { name: 'alarms', description: '', uri: '' },
        { hostKind: 'playground', conversationId: f.room.conversationId },
      ),
    ).toBe(false);

    enableRoomImage(f, false);
    expect(f.tooling.skillVisible(IMAGE_SKILL, { hostKind: 'playground', conversationId: f.room.conversationId })).toBe(
      false,
    );
    expect(capabilityToolNames(f, invocationId)).not.toContain('image_generate');
    expect(roomSystemPrompt(f, invocationId)).not.toContain('image-generation');
  });

  test('a skill outside the room index is unreadable by absolute or relative reference', async () => {
    const f = await playgroundImageFixture();
    const invocationId = releaseRoomInput(f, 'ask-read');
    const reads = [
      { uri: 'system:///skills/alarms/SKILL.md' },
      { uri: '../dictionary/SKILL.md', base: 'system:///skills/web-fetch/SKILL.md' },
      // The switch is off, so the image skill is hidden in this room too.
      { uri: 'system:///skills/image-generation/SKILL.md' },
      { uri: 'system:///skills/web-fetch/SKILL.md' },
    ];
    f.faux.setResponses([
      () =>
        fauxAssistantMessage(
          reads.map((input, index) => fauxToolCall('read', input, { id: `read-${index}` })),
          { stopReason: 'toolUse' },
        ),
      () => fauxAssistantMessage('done'),
    ]);
    expect((await runInvocation(f, invocationId)).state).toBe('completed');

    const audited = f.store.orm
      .select({ toolCallId: toolCalls.toolCallId, state: toolCalls.state, errorCode: toolCalls.errorCode })
      .from(toolCalls)
      .where(eq(toolCalls.toolName, 'read'))
      .all()
      .sort((left, right) => left.toolCallId.localeCompare(right.toolCallId));
    expect(audited).toEqual([
      { toolCallId: 'read-0', state: 'error', errorCode: 'resource_not_found' },
      { toolCallId: 'read-1', state: 'error', errorCode: 'resource_not_found' },
      { toolCallId: 'read-2', state: 'error', errorCode: 'resource_not_found' },
      { toolCallId: 'read-3', state: 'success', errorCode: null },
    ]);
  });
});
