import type { AgentTool } from '@earendil-works/pi-agent-core';
import Type from 'typebox';

import type { ImActivity, ImDeliveryTarget } from '../platform/im-host.ts';

/**
 * The `typing` capability: it decides *when* to ask for a chat action. Keeping
 * the action fresh, capping it, and giving up quietly are the host's job, so
 * this tool carries no timer and no transport at all.
 *
 * One invocation may ask again after each idle boundary, never after its cap.
 */
export function createTyping(
  activity: ImActivity,
  target: ImDeliveryTarget,
  signal: AbortSignal,
): { readonly tool: AgentTool; readonly stop: () => void } {
  let started = false;
  const stop = (): void => {
    if (started) {
      started = false;
      activity.stop(target.conversation);
    }
  };
  signal.addEventListener('abort', stop, { once: true });
  const tool: AgentTool = {
    name: 'typing',
    label: 'Start typing',
    description:
      'Show typing only after deciding to reply when search or other work will take noticeable time. Optional: send quick replies directly and stay silent when no reply is warranted. Call once before slow work; the runtime refreshes and stops the status automatically. This does not publish a reply or guarantee delivery.',
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (_id, _input, toolSignal) => {
      if (signal.aborted || toolSignal?.aborted) {
        throw new Error('Typing cancelled');
      }
      if (!started) {
        activity.start(target, 'until_stop');
        started = true;
      }
      return { content: [{ type: 'text', text: 'Typing requested; use send to publish the reply.' }], details: {} };
    },
  };
  return { tool, stop };
}
