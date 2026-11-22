/**
 * Checks the documentation screenshot assets: the manifest and the PNGs it
 * names.
 *
 * The docs suite writes both (`apps/admin-next/docs-screenshots/`), and the
 * committed result must be self-consistent before a page embeds a file:
 *
 * - `manifest.json` is valid against its schema and small enough to review;
 * - every scenario has exactly the two locale PNGs, and nothing else is in the
 *   directory: a leftover `.tmp`, an upper-case `.PNG` or a renamed file would
 *   otherwise be published next to the real assets;
 * - ids and file names follow the documented pattern, so a page can build the
 *   path from the id and the locale;
 * - every file really decodes as a PNG (size and pixel data), not an HTML error
 *   page or a truncated write that kept its header.
 *
 * A caller may pass the scenario catalog's ids (`expectedIds`) so a manifest
 * that quietly dropped a scenario is rejected too; the manifest alone cannot
 * prove that. `apps/admin-next/docs-screenshots/manifest.ts` uses that when it
 * publishes a run, and `test/docs/screenshot-assets.test.ts` uses it for the
 * committed set.
 *
 * This module is intentionally not wired into `scripts/docs/verify.ts` yet
 * (epic G adds it there together with the per-locale page reference check).
 */
import { open, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import Type from 'typebox';
import type { TLocalizedValidationError } from 'typebox/error';
import { Value } from 'typebox/value';

/** Repository-relative home of every documentation screenshot. */
export const SCREENSHOTS_DIRECTORY = resolve(
  import.meta.dirname,
  '..',
  '..',
  'apps',
  'docs',
  'content',
  'public',
  'screenshots',
);

/** `<topic>/<state>`, both lower-case kebab segments. */
export const SCENARIO_ID_PATTERN = '^[a-z0-9-]+/[a-z0-9-]+$';

export const SCREENSHOT_LOCALES = ['zh-CN', 'en'] as const;

export type ScreenshotLocale = (typeof SCREENSHOT_LOCALES)[number];

/** The manifest is committed as text and must stay readable in one review. */
export const MANIFEST_MAX_BYTES = 20_000;

const PNG_SIGNATURE_LENGTH = 8;

const ScenarioSchema = Type.Object(
  {
    id: Type.String({ pattern: SCENARIO_ID_PATTERN }),
    description: Type.String({ minLength: 1, maxLength: 240 }),
    target: Type.String({ minLength: 1, maxLength: 400 }),
    locales: Type.Array(Type.Union([Type.Literal('zh-CN'), Type.Literal('en')]), { minItems: 2, maxItems: 2 }),
    // A doc page path without the locale directory, e.g. `guides/first-bot`.
    pages: Type.Array(Type.String({ pattern: '^[a-z0-9-]+(?:/[a-z0-9-]+)+$' }), { minItems: 1 }),
  },
  { additionalProperties: false },
);

const ManifestSchema = Type.Object(
  {
    version: Type.Literal(1),
    generator: Type.Object(
      {
        commit: Type.String({ pattern: '^[a-f0-9]{7,40}$' }),
        playwright: Type.String({ minLength: 1, maxLength: 40 }),
        chromium: Type.String({ minLength: 1, maxLength: 40 }),
        platform: Type.String({ minLength: 1, maxLength: 40 }),
        viewport: Type.Object(
          {
            width: Type.Integer({ minimum: 320, maximum: 4096 }),
            height: Type.Integer({ minimum: 320, maximum: 4096 }),
          },
          { additionalProperties: false },
        ),
        device_scale_factor: Type.Number({ minimum: 1, maximum: 4 }),
        /** Whether the source tree (screenshots excluded) had uncommitted changes. */
        worktree_dirty: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    scenarios: Type.Array(ScenarioSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export interface ScreenshotAssetReport {
  readonly ok: boolean;
  /** One line per problem; empty when `ok` is true. */
  readonly errors: readonly string[];
  /** Scenario and PNG counts, for a caller that wants to print a summary. */
  readonly scenarioCount: number;
  readonly fileCount: number;
}

export interface CheckOptions {
  /** The screenshots directory; defaults to the repository's docs assets. */
  readonly directory?: string;
  /**
   * The scenario ids the caller requires (the catalog). When given, a manifest
   * missing one of them or listing an unknown one is an error.
   */
  readonly expectedIds?: readonly string[];
}

async function walk(directory: string, base: string = directory): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path, base)));
    } else {
      files.push(relative(base, path).split(sep).join('/'));
    }
  }
  return files.sort();
}

/** A decodable PNG with real dimensions; a truncated body is not one. */
async function isDecodablePng(path: string): Promise<boolean> {
  try {
    // The signature is cheap to read; the decode below is what catches a
    // truncated write that still starts like a PNG.
    const handle = await open(path, 'r');
    try {
      const signature = Buffer.alloc(PNG_SIGNATURE_LENGTH);
      const { bytesRead } = await handle.read(signature, 0, PNG_SIGNATURE_LENGTH, 0);
      if (
        bytesRead !== PNG_SIGNATURE_LENGTH ||
        !signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ) {
        return false;
      }
    } finally {
      await handle.close();
    }
    const metadata = await sharp(path).metadata();
    return metadata.format === 'png' && (metadata.width ?? 0) > 0 && (metadata.height ?? 0) > 0;
  } catch {
    return false;
  }
}

function describeErrors(prefix: string, errors: readonly TLocalizedValidationError[]): string[] {
  return errors.map(
    (error) => `${prefix}${error.instancePath === '' ? '' : ` at ${error.instancePath}`}: ${error.message}`,
  );
}

/**
 * Validates the manifest and every file under `directory`. Returns a report
 * instead of throwing so the caller (test or publish step) can print all
 * problems at once.
 */
export async function checkScreenshotAssets(options: CheckOptions = {}): Promise<ScreenshotAssetReport> {
  const directory = options.directory ?? SCREENSHOTS_DIRECTORY;
  const errors: string[] = [];
  const manifestPath = join(directory, 'manifest.json');

  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, 'utf8');
  } catch {
    return {
      ok: false,
      errors: [`Missing manifest: ${manifestPath}`],
      scenarioCount: 0,
      fileCount: 0,
    };
  }
  const manifestBytes = Buffer.byteLength(manifestText, 'utf8');
  if (manifestBytes > MANIFEST_MAX_BYTES) {
    errors.push(`manifest.json is ${String(manifestBytes)} bytes; keep it under ${String(MANIFEST_MAX_BYTES)}`);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    return {
      ok: false,
      errors: [...errors, `manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
      scenarioCount: 0,
      fileCount: 0,
    };
  }
  if (!Value.Check(ManifestSchema, manifest)) {
    const schemaErrors = describeErrors('manifest.json', Value.Errors(ManifestSchema, manifest));
    return { ok: false, errors: [...errors, ...schemaErrors], scenarioCount: 0, fileCount: 0 };
  }

  const scenarios = manifest.scenarios;
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) {
      errors.push(`Duplicate scenario id: ${scenario.id}`);
    }
    seen.add(scenario.id);
    const locales = [...scenario.locales].sort().join(',');
    if (locales !== [...SCREENSHOT_LOCALES].sort().join(',')) {
      errors.push(`${scenario.id}: locales must be exactly ${SCREENSHOT_LOCALES.join(' + ')}`);
    }
  }

  if (options.expectedIds !== undefined) {
    const expected = new Set(options.expectedIds);
    for (const id of options.expectedIds) {
      if (!seen.has(id)) {
        errors.push(`Manifest is missing scenario: ${id}`);
      }
    }
    for (const scenario of scenarios) {
      if (!expected.has(scenario.id)) {
        errors.push(`Manifest lists a scenario outside the catalog: ${scenario.id}`);
      }
    }
  }

  let files: string[];
  try {
    files = await walk(directory);
  } catch {
    return {
      ok: false,
      errors: [...errors, `Missing screenshots directory: ${directory}`],
      scenarioCount: scenarios.length,
      fileCount: 0,
    };
  }
  const pngs = files.filter((file) => file.endsWith('.png'));
  const expectedFiles = new Set(
    scenarios.flatMap((scenario) => SCREENSHOT_LOCALES.map((locale) => `${scenario.id}.${locale}.light.png`)),
  );

  // Every scenario has both locale files, and the directory holds nothing else:
  // an unexpected name would be published next to the real assets.
  for (const scenario of scenarios) {
    for (const locale of SCREENSHOT_LOCALES) {
      const expected = `${scenario.id}.${locale}.light.png`;
      if (!files.includes(expected)) {
        errors.push(`Missing screenshot: ${expected}`);
      }
    }
  }
  for (const file of files) {
    if (file !== 'manifest.json' && !expectedFiles.has(file)) {
      errors.push(`Unlisted file in the screenshots directory: ${file}`);
    }
  }
  for (const file of pngs) {
    if (expectedFiles.has(file) && !(await isDecodablePng(join(directory, file)))) {
      errors.push(`Not a decodable PNG: ${file}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    scenarioCount: scenarios.length,
    fileCount: pngs.length,
  };
}
