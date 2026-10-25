import { sql } from 'drizzle-orm';
import type { Orm } from './store.ts';
import { hostSends } from './schema/index.ts';

/** The delivery ledger is the audit, including attempts interrupted by a restart. */
export function imageDeliveryState(orm: Orm, conversationId: bigint, generationId: string) {
  const rows = orm.all<{
    asset_id: string | null;
    state: string;
    message_ref: bigint | null;
    unknown_assets: bigint;
  }>(sql`
    SELECT asset.value AS asset_id, s.state,
      -- Both hosts record the host-native id of the delivered message in the
      -- response: the wire id for Telegram (also in telegram_message_id), the
      -- sequence number for a room. That is the id the model may be told; the
      -- room's message_id column is a storage row id and is cleared when
      -- retention deletes the message, while the response keeps naming it.
      COALESCE(
        s.telegram_message_id,
        CAST(json_extract(s.response_json, '$.message_id') AS INTEGER)
      ) AS message_ref,
      COALESCE(json_extract(s.request_json, '$.asset_ids_unknown'), 0) AS unknown_assets
    FROM ${hostSends} s
    LEFT JOIN json_each(s.request_json, '$.asset_ids') asset ON asset.type = 'text'
    WHERE s.conversation_id = ${conversationId} AND s.kind = 'image'
      AND json_extract(s.request_json, '$.generation_id') = ${generationId}
      AND s.state IN ('success', 'pending', 'outcome_unknown')
    ORDER BY s.id
  `);
  const delivered = new Map<string, string>();
  const uncertain = new Set<string>();
  let unknownAssets = false;
  for (const row of rows) {
    if (row.unknown_assets !== 0n || row.asset_id === null) {
      unknownAssets = true;
      continue;
    }
    if (row.state === 'success' && row.message_ref !== null) {
      delivered.set(row.asset_id, row.message_ref.toString());
    } else {
      uncertain.add(row.asset_id);
    }
  }
  return { delivered, uncertain, unknownAssets };
}
