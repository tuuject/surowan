import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import type { DeliveryPolicy } from '../platform/invocation-context.ts';
import { jsonText } from './long-tasks-json.ts';
import { positiveInt64 } from './long-tasks-list.ts';

const DeliverySchema = Type.Object(
  {
    bypassDailyBudget: Type.Boolean(),
    mentionUser: Type.Optional(
      Type.Object(
        {
          userId: Type.String({ pattern: '^[1-9][0-9]*$' }),
          displayName: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const deliveryValidator = Compile(DeliverySchema);
const MAX_DELIVERY = 4_096;

type StoredDelivery = Static<typeof DeliverySchema>;

export function deliveryText(policy: DeliveryPolicy | undefined): string {
  const value: Record<string, unknown> = { bypassDailyBudget: policy?.bypassDailyBudget ?? false };
  if (policy?.mentionUser !== undefined) {
    value.mentionUser = {
      userId: positiveInt64(policy.mentionUser.userId).toString(),
      displayName: policy.mentionUser.displayName,
    };
  }
  if (!deliveryValidator.Check(value)) {
    throw new Error('delivery policy is invalid');
  }
  return jsonText(value, MAX_DELIVERY, 'delivery');
}

export function readDelivery(text: string): DeliveryPolicy {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid delivery in database');
  }
  if (!deliveryValidator.Check(value)) {
    throw new Error('Invalid delivery in database');
  }
  return fromStoredDelivery(value);
}

function fromStoredDelivery(value: StoredDelivery): DeliveryPolicy {
  if (value.mentionUser === undefined) {
    return { bypassDailyBudget: value.bypassDailyBudget };
  }
  return {
    bypassDailyBudget: value.bypassDailyBudget,
    mentionUser: {
      userId: BigInt(value.mentionUser.userId),
      displayName: value.mentionUser.displayName,
    },
  };
}
