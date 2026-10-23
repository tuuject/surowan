import type { Generation } from '../src/contracts.ts';
import { adminActor, type createTestCore, waitFor } from './helpers.ts';

export async function waitForGeneration(
  run: Awaited<ReturnType<typeof createTestCore>>,
  id: string,
): Promise<Generation> {
  return waitFor(() => {
    const row = run.core.generations.getRow(id);
    if (row === null) {
      return null;
    }
    if (row.status === 'queued' || row.status === 'running') {
      return null;
    }
    return run.core.generations.get(id, adminActor);
  });
}
