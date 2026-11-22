import { useLang } from '@rspress/core/runtime';
import buildInfo from '../content/public/build-info.json';

const repository = 'https://github.com/tuuject/surowan';

/**
 * The commit provenance shown above every page and carried into the rendered
 * Markdown. The sentence comes from `scripts/docs/locales.ts` through
 * `build-info.json`, and `docs:verify` compares the output with that exact string.
 *
 * The whole sentence is one link: keeping it a single text node leaves it
 * contiguous in the HTML and in the page's Markdown, where the verifier looks for
 * it verbatim. The visible short SHA is part of the sentence, the full one is in
 * the link target.
 */
export function VersionNotice() {
  const text = buildInfo.locale[useLang() === 'en' ? 'en' : 'zh'];
  return (
    <p className="version-notice">
      <a href={`${repository}/commit/${buildInfo.commit}`} target="_blank" rel="noopener noreferrer">
        {text.provenance}
      </a>
    </p>
  );
}
