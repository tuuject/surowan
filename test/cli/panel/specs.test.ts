import { describe, expect, it } from 'vitest';
import { OPTIONS } from '../../../packages/cli/src/args/spec.ts';
import { PANEL_SPECS } from '../../../packages/cli/src/panel/specs/index.ts';
import { loginPanel, panelFixture, runCli } from './fixtures.ts';

describe('surowan-utils panel spec table', () => {
  it('declares every query flag a route forwards as a CLI option', () => {
    // A param missing from OPTIONS is rejected by the argument parser before
    // the spec ever sees it, so the route silently loses that filter.
    const missing = PANEL_SPECS.flatMap((spec) =>
      (spec.params ?? [])
        .map((entry) => entry.split('=')[0] ?? '')
        .filter((flag) => !Object.hasOwn(OPTIONS, flag))
        .map((flag) => `${spec.command} --${flag}`),
    );
    expect(missing).toEqual([]);
  });

  it('forwards --days to the usage series', async () => {
    const fixture = await panelFixture();
    try {
      await loginPanel(fixture);
      const usage = await runCli(['usage', '--days', '30', '--json'], fixture);
      expect(usage.code, usage.stderr).toBe(0);
      const series = JSON.parse(usage.stdout) as { days: number; series: readonly unknown[] };
      expect(series.days).toBe(30);
      expect(series.series).toHaveLength(30);
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
