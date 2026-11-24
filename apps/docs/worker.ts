/**
 * Cloudflare Worker in front of the static docs build. Every page is published
 * twice by Rspress: `page.html` for browsers and `page.md` for agents. A request
 * that prefers `text/markdown` over `text/html` gets the `.md` file at the page's
 * own URL; everything else, including the 404 page and `_redirects`, is left to
 * the static-assets layer through the `ASSETS` binding.
 *
 * `wrangler.jsonc` runs this script first only for page routes; JS, CSS,
 * screenshots, examples and the `.md`/`.txt`/`.json` files are served without it.
 * The path mapping never adds the deployment base, so it serves `/` and a subpath
 * build alike (`docs:verify` drives it against both).
 */

/** The subset of the Workers static-assets binding this script uses. */
export interface DocsAssets {
  fetch(request: Request): Promise<Response>;
}

export interface DocsWorkerEnv {
  readonly ASSETS: DocsAssets;
}

const MARKDOWN_TYPE = 'text/markdown; charset=utf-8';

/** Quality of each media range in an `Accept` header; a repeated range keeps its highest value. */
function acceptQualities(accept: string): Map<string, number> {
  const qualities = new Map<string, number>();
  for (const range of accept.split(',')) {
    const [type = '', ...parameters] = range.split(';');
    const mediaType = type.trim().toLowerCase();
    if (!mediaType) {
      continue;
    }
    let quality = 1;
    for (const parameter of parameters) {
      const [name = '', value = ''] = parameter.split('=');
      if (name.trim().toLowerCase() === 'q') {
        const parsed = Number(value.trim());
        quality = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
      }
    }
    qualities.set(mediaType, Math.max(quality, qualities.get(mediaType) ?? 0));
  }
  return qualities;
}

/**
 * Markdown is served only when the client names `text/markdown` itself and
 * ranks it at least as high as HTML. Wildcards never select Markdown, so a
 * browser's catch-all range keeps getting HTML; HTML's own rank falls back to
 * the `text` wildcard and then the any-type wildcard, as negotiation specifies.
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) {
    return false;
  }
  const qualities = acceptQualities(accept);
  const markdown = qualities.get('text/markdown') ?? 0;
  const html = qualities.get('text/html') ?? qualities.get('text/*') ?? qualities.get('*/*') ?? 0;
  return markdown > 0 && markdown >= html;
}

/**
 * The `.md` file published next to the page a URL path names, or `null` when the
 * path is not a page (a file with another extension, or already Markdown).
 * Directory routes keep their index file name, as the `.html` output does.
 */
export function markdownPathFor(pathname: string): string | null {
  if (pathname.endsWith('/')) {
    return `${pathname}index.md`;
  }
  const name = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (name.endsWith('.html')) {
    return `${pathname.slice(0, -'.html'.length)}.md`;
  }
  return name.includes('.') ? null : `${pathname}.md`;
}

/** Binding responses have immutable headers, so `Vary: Accept` goes on a copy. */
function withVary(response: Response, contentType?: string): Response {
  const copy = new Response(response.body, response);
  const vary = copy.headers.get('vary') ?? '';
  if (!vary.split(',').some((field) => field.trim().toLowerCase() === 'accept')) {
    copy.headers.set('vary', vary ? `${vary}, Accept` : 'Accept');
  }
  if (contentType !== undefined) {
    copy.headers.set('content-type', contentType);
  }
  return copy;
}

export default {
  async fetch(request: Request, env: DocsWorkerEnv): Promise<Response> {
    if ((request.method === 'GET' || request.method === 'HEAD') && prefersMarkdown(request.headers.get('accept'))) {
      const url = new URL(request.url);
      const markdownPath = markdownPathFor(url.pathname);
      if (markdownPath !== null) {
        url.pathname = markdownPath;
        // `manual`: the binding would otherwise follow a `_redirects` rule for a
        // retired `.md` URL and serve the new page under the old address.
        const markdown = await env.ASSETS.fetch(
          new Request(url, { method: request.method, headers: request.headers, redirect: 'manual' }),
        );
        if (markdown.status === 200 || markdown.status === 304) {
          return withVary(markdown, MARKDOWN_TYPE);
        }
        // A missing page or a retired URL: the original request reaches the static
        // 404 page or its `_redirects` rule, and the client negotiates again there.
      }
    }
    return withVary(await env.ASSETS.fetch(request));
  },
};
