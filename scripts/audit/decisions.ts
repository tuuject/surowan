import type Database from 'better-sqlite3';

/**
 * The entry gate's audit rows, for the two questions the audit script answers:
 * what happened to this Bucket, and why did the bot stay silent in this
 * Conversation.
 */

export interface DecisionRow {
  readonly id: number;
  readonly bucket_id: number;
  readonly conversation_id: number;
  readonly mode: string;
  readonly model: string;
  readonly state: string;
  readonly outcome: string | null;
  readonly applied: number;
  readonly probability: number | null;
  readonly threshold: number;
  readonly history_count: number;
  readonly pending_count: number;
  readonly input_tokens: number | null;
  readonly cost: number | null;
  readonly duration_ms: number | null;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

const COLUMNS = `id, bucket_id, conversation_id, mode, model, state, outcome, applied, probability,
  threshold, history_count, pending_count, input_tokens, cost, duration_ms, error_code,
  substr(error_detail, 1, 300) AS error_detail, created_at, finished_at`;

export function loadBucketDecisions(database: Database.Database, bucketId: number): DecisionRow[] {
  return database
    .prepare<[number], DecisionRow>(`SELECT ${COLUMNS} FROM bucket_decisions WHERE bucket_id = ? ORDER BY id`)
    .all(bucketId);
}

/**
 * Every decision of the Buckets one Invocation consumed: the opening Bucket plus
 * whatever `attachDueBucket` attached to the same run. The gate decided those
 * too, and the audit has to show it.
 */
export function loadInvocationDecisions(
  database: Database.Database,
  invocationId: number,
  openingBucketId: number,
): DecisionRow[] {
  return database
    .prepare<[number, number], DecisionRow>(
      `SELECT ${COLUMNS} FROM bucket_decisions
       WHERE bucket_id = ?
          OR bucket_id IN (SELECT bucket_id FROM invocation_buckets WHERE invocation_id = ?)
       ORDER BY id`,
    )
    .all(openingBucketId, invocationId);
}

export function loadConversationDecisions(
  database: Database.Database,
  conversationId: number,
  limit: number,
): DecisionRow[] {
  return database
    .prepare<[number, number], DecisionRow>(
      `SELECT ${COLUMNS} FROM bucket_decisions WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(conversationId, limit);
}

/** One line per decision: the verdict, whether it was applied, and what it cost. */
export function renderDecision(row: DecisionRow): string {
  const probability = row.probability === null ? '-' : row.probability.toFixed(3);
  return [
    `#${row.id} bucket=${row.bucket_id} ${row.mode} ${row.state}`,
    `outcome=${row.outcome ?? '-'}`,
    `applied=${row.applied === 1}`,
    `p=${probability}/${row.threshold}`,
    `messages=${row.history_count}/${row.pending_count}`,
    `tokens=${row.input_tokens ?? '-'}`,
    `cost=${row.cost ?? '-'}`,
    `duration=${row.duration_ms ?? '-'}ms`,
    `${row.error_code ?? ''}${row.error_code === null ? '' : `: ${row.error_detail ?? ''}`}`,
  ]
    .join(' ')
    .trimEnd();
}

/**
 * What the rows prove about the gate, in the script's mechanical voice. The
 * wording follows `mode` and `state`: a `shadow` drop withheld nothing, a
 * `stale` verdict was discarded, and an `interrupted` row is a restart leftover
 * — not a failure that admitted a batch.
 */
export function describeDecisions(rows: readonly DecisionRow[]): string[] {
  const lines: string[] = [];
  const count = (predicate: (row: DecisionRow) => boolean): number => rows.filter(predicate).length;

  const shadowDrops = count((row) => row.mode === 'shadow' && row.outcome === 'drop');
  if (shadowDrops > 0) {
    lines.push(`入场闸门在 shadow 模式下判定过 ${shadowDrops} 次「抛弃」：只记录，不改变批次`);
  }
  const dropped = count(
    (row) => row.mode === 'enforce' && row.state === 'success' && row.outcome === 'drop' && row.applied === 1,
  );
  if (dropped > 0) {
    lines.push(`入场闸门在 enforce 下抛弃了 ${dropped} 个批次（Bucket 记为 skipped_budget / decision_gate_dropped）`);
  }
  const discarded = count((row) => row.mode === 'enforce' && row.state === 'stale');
  if (discarded > 0) {
    lines.push(
      `入场闸门有 ${discarded} 次判定作废（state = stale）：Bucket 已不在 collecting，或批次在决策期间变化后重新决策`,
    );
  }
  const notApplied = count(
    (row) => row.mode === 'enforce' && row.state !== 'stale' && row.applied === 0 && row.error_code !== 'interrupted',
  );
  if (notApplied > 0) {
    lines.push(`入场闸门有 ${notApplied} 次判定没有生效（applied = 0）：结果回来时该 Chat 已不在 enforce 模式`);
  }
  const interrupted = count((row) => row.error_code === 'interrupted');
  if (interrupted > 0) {
    lines.push(`入场闸门有 ${interrupted} 行是进程重启留下的 interrupted：那次判定没有结论，批次被重新处理`);
  }
  const failed = rows.filter((row) => row.state === 'error' && row.error_code !== 'interrupted');
  if (failed.length > 0) {
    const codes = [...new Set(failed.map((row) => row.error_code ?? 'unknown'))].join(', ');
    lines.push(`入场闸门有 ${failed.length} 次失败（${codes}）：失败一律送入`);
  }
  return lines;
}
