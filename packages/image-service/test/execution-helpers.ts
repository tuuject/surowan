import type { Generation, GenerationInput } from '../src/contracts.ts';
import { adminActor, parseInput, type TestCore, waitFor } from './helpers.ts';

export async function submit(
  run: TestCore,
  payload: Partial<GenerationInput> & { authoredPrompt: string },
  key: string,
) {
  return run.core.generations.create(parseInput({ modelId: 'gpt-image-1', ...payload }), adminActor, key).generation.id;
}

export async function finished(run: TestCore, id: string): Promise<Generation> {
  return waitFor(() => {
    const row = run.core.generations.getRow(id);
    if (row === null || row.status === 'queued' || row.status === 'running') {
      return null;
    }
    return run.core.generations.get(id, adminActor);
  });
}

export function abortable(signal: AbortSignal | null | undefined): { promise: Promise<never> } {
  let rejectFn: (error: Error) => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectFn = reject;
  });
  const abort = (): void => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    rejectFn(error);
  };
  if (signal == null) {
    return { promise };
  }
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener('abort', abort, { once: true });
  }
  return { promise };
}
