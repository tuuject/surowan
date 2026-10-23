import { rm } from 'node:fs/promises';

/** Temp directories created by the agent-runtime tests; cleaned once per test file. */
export const directories: string[] = [];

export async function cleanupAgentRuntimeDirectories(): Promise<void> {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}
