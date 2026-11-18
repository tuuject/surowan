import { defineConfig } from 'vitest/config';

const TEST_GLOBS = [
  'test/**/*.test.ts',
  'apps/admin-next/src/**/*.test.ts',
  'packages/image-service/test/**/*.test.ts',
];

// Files that vi.mock a module other suites also evaluate (node:fs/promises,
// grammy, src/platform/subprocess.ts, @inquirer/prompts). Under a shared module registry the mock
// factory only applies while the file that registered it is running, so these
// keep per-file isolation — each gets its own worker, exactly as before.
const ISOLATED_FILES = [
  'test/admin/invocation-media-failures.test.ts',
  'test/admin/invocation-media-read-window.test.ts',
  'test/image/startup.test.ts',
  'test/media/image.test.ts',
  'test/memo/blobs.test.ts',
  'test/memo/image.test.ts',
  'test/playground/only.test.ts',
  'test/tui-secret-ref.test.ts',
];

export default defineConfig({
  test: {
    setupFiles: ['test/setup/pin-browser-language.ts'],
    // One worker, sequential files: fixtures still assume a deterministic
    // single-process run order (module-level fixture state, process.env edits,
    // console/stdin spies, child processes probing ephemeral ports). Parallel
    // files would also hide the next cross-file state leak behind timing.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'isolated',
          include: ISOLATED_FILES,
          isolate: true,
        },
      },
      {
        test: {
          name: 'shared',
          include: TEST_GLOBS,
          exclude: ISOLATED_FILES,
          // One module registry for the suite: re-evaluating every module per
          // file cost ~500s, nearly half the wall time. Suite fixtures
          // register teardown through onTestFinished so cleanup binds to the
          // test that opened the resource, not to whichever file evaluated
          // the fixture module first.
          isolate: false,
        },
      },
    ],
  },
});
