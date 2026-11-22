/**
 * Records failures for the teardown's publish decision.
 *
 * `publishScreenshots` only replaces the committed images when every expected
 * file exists *and* no test failed: a test that fails after its last capture
 * would otherwise publish a set that no longer matches what the specs assert.
 * The record is written from `onTestEnd`, which is guaranteed to run while the
 * run is still going (the run-wide hooks of a reporter are not ordered against
 * the global teardown). Its absence therefore means "no failure seen".
 *
 * The file lives inside the staging directory, which the next run clears, so a
 * missing file can only mean a clean run.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SCREENSHOTS_FAILURES_FILE } from './capture.ts';

export interface ScreenshotRunFailure {
  readonly failures: readonly string[];
}

/** What Playwright hands `onTestEnd`; only the identity and status are used. */
export interface ScreenshotTestResult {
  readonly status: string;
}

/** The hooks this reporter uses; typed locally so no internal Playwright type is imported. */
export interface ScreenshotReporter {
  onTestEnd(test: { titlePath(): readonly string[] }, result: ScreenshotTestResult): Promise<void>;
}

const FAILING_STATUSES = new Set(['failed', 'timedOut', 'interrupted']);

async function readFailures(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(SCREENSHOTS_FAILURES_FILE, 'utf8')) as ScreenshotRunFailure;
    return Array.isArray(parsed.failures) ? [...parsed.failures] : [];
  } catch {
    return [];
  }
}

export default function screenshotRunReporter(): ScreenshotReporter {
  return {
    onTestEnd: async (test, result) => {
      if (!FAILING_STATUSES.has(result.status)) {
        return;
      }
      const failures = await readFailures();
      failures.push(`${result.status}: ${test.titlePath().join(' › ')}`);
      await mkdir(dirname(SCREENSHOTS_FAILURES_FILE), { recursive: true });
      await writeFile(SCREENSHOTS_FAILURES_FILE, `${JSON.stringify({ failures } satisfies ScreenshotRunFailure)}\n`);
    },
  };
}
