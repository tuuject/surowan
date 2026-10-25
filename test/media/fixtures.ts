/**
 * Shared temp-directory fixture for the media suites.
 *
 * Every media test writes into a real temp directory (config, fixture images,
 * downloads), so the directories are collected here and removed once per
 * importing test file.
 *
 * This is not a test file: it is imported by the `media*.test.ts` suites, and
 * registers their shared temp-directory cleanup.
 */
import { afterAll } from 'vitest';
import { rm } from 'node:fs/promises';

/** Temp directories created by the media suites; cleaned once per test file. */
export const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});
