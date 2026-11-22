import { publishScreenshots } from './manifest.ts';

/**
 * Publishes the run: validates the staged set and replaces the public
 * screenshots directory, or throws and leaves the previous images in place.
 * A focused run (`DOCS_SHOTS_ALLOW_INCOMPLETE=1`) only reports its staging
 * directory.
 */
export default async function globalTeardown(): Promise<void> {
  await publishScreenshots();
}
