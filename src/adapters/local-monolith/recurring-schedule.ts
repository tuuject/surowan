import { Cron } from 'croner';
import type { RecurringScheduleEngine, RuleIssue } from '../../platform/recurring-schedule.ts';

/**
 * croner-backed occurrence math. The only module that imports croner: the
 * jobs it builds are paused and never scheduled, so croner keeps no timers and
 * the store's persisted next occurrence stays the only wake-up source.
 */
export class CronerScheduleEngine implements RecurringScheduleEngine {
  validate(rules: readonly string[], timeZone: string, now: Date): RuleIssue[] {
    const issues: RuleIssue[] = [];
    rules.forEach((rule, index) => {
      try {
        const job = cron(rule, timeZone);
        const next = job.nextRun(now);
        job.stop();
        if (next === null) {
          issues.push({ index, code: 'never_fires', message: 'this rule never fires again' });
        }
      } catch (error) {
        issues.push({ index, code: 'syntax', message: error instanceof Error ? error.message : String(error) });
      }
    });
    return issues;
  }

  nextAfter(rules: readonly string[], timeZone: string, after: Date): Date | null {
    let earliest: Date | null = null;
    for (const rule of rules) {
      const job = cron(rule, timeZone);
      const next = job.nextRun(after);
      job.stop();
      if (next !== null && (earliest === null || next.getTime() < earliest.getTime())) {
        earliest = next;
      }
    }
    return earliest;
  }
}

function cron(rule: string, timeZone: string): Cron {
  // Vixie semantics: a restricted day-of-month and day-of-week are ORed.
  return new Cron(rule, { mode: '5-part', timezone: timeZone, domAndDow: false, paused: true });
}
