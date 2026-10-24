/**
 * Read-only audit helper for a Surowan database.
 *
 * Answers the question an operator actually asks — "why did the bot reply, or
 * why did it stay silent?" — from the audit trail alone: the frozen batch the
 * model saw, every model call, every tool call, every `send`, and the private
 * assistant text plus harness nudges that never reached Telegram. The database
 * is opened read-only; this script never writes to it.
 *
 * Usage:
 *   node scripts/audit.ts invocation <id> [--db <path>] [--json]
 *   node scripts/audit.ts conversation <id> [--limit n] [--db <path>] [--json]
 *   node scripts/audit.ts prompt <invocationId> [--out <file>] [--db <path>]
 *   node scripts/audit.ts search --text <text> [--since <iso>] [--limit n] [--db <path>] [--json]
 */
import { main } from './audit/main.ts';

await main();
