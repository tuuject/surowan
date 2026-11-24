import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import docsWorker from '../../apps/docs/worker.ts';

export interface MarkdownNegotiationTarget {
  /** Origin of the running preview server that stands in for the `ASSETS` binding. */
  readonly previewOrigin: string;
  /** Public origin the Worker sees in request URLs. */
  readonly origin: string;
  /** Deployment base, with leading and trailing slash. */
  readonly base: string;
  /** Absolute path of the built site. */
  readonly dist: string;
  /** Every page's `.md` path below the base, per locale. */
  readonly pageSets: Iterable<readonly string[]>;
}

/**
 * Drive the production Worker (`apps/docs/worker.ts`) with the preview server as
 * its `ASSETS` binding: every page URL form must negotiate to the exact `.md`
 * artifact for an agent and to the exact `.html` artifact for a browser. The
 * Cloudflare-only parts (`run_worker_first` patterns, `_redirects` behind the
 * binding) are not emulated here and still need a check on the deployed host.
 * Returns the number of pages checked.
 */
export async function verifyMarkdownNegotiation(target: MarkdownNegotiationTarget): Promise<number> {
  const { previewOrigin, origin, base, dist, pageSets } = target;
  const assets = {
    fetch: (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      return fetch(`${previewOrigin}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
    },
  };
  const agentAccept = 'text/markdown, text/html;q=0.9, */*;q=0.8';
  const browserAccept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  const request = async (path: string, accept: string | null, method = 'GET'): Promise<Response> =>
    docsWorker.fetch(new Request(`${origin}${base}${path}`, { method, headers: accept === null ? {} : { accept } }), {
      ASSETS: assets,
    });
  const expectServed = async (response: Response, artifact: string, label: string): Promise<void> => {
    assert.equal(response.status, 200, `Negotiation failed: ${label}`);
    assert(/(?:^|,)\s*accept\s*(?:,|$)/i.test(response.headers.get('vary') ?? ''), `Missing Vary: Accept: ${label}`);
    const type = response.headers.get('content-type') ?? '';
    assert(
      artifact.endsWith('.md') ? type.startsWith('text/markdown') : type.includes('text/html'),
      `Wrong negotiated type for ${label}: ${type}`,
    );
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      await readFile(resolve(dist, artifact)),
      `Negotiated body is not ${artifact}: ${label}`,
    );
  };

  let count = 0;
  for (const pages of pageSets) {
    for (const page of pages) {
      const html = page.replace(/\.md$/, '.html');
      const bare = page.endsWith('index.md') ? page.slice(0, -'index.md'.length) : page.slice(0, -'.md'.length);
      for (const path of new Set([bare, html])) {
        await expectServed(await request(path, agentAccept), page, `${path} as an agent`);
      }
      await expectServed(await request(html, browserAccept), html, `${html} as a browser`);
      count += 1;
    }
  }

  // The Accept rules on one page: Markdown only when named and ranked at least as high as HTML.
  const sample = 'docs/guides/installation';
  for (const [accept, artifact] of [
    ['text/markdown', `${sample}.md`],
    ['TEXT/Markdown; charset=utf-8', `${sample}.md`],
    ['text/html;q=0.5, text/markdown;q=0.8', `${sample}.md`],
    ['text/html, text/markdown', `${sample}.md`],
    ['text/html, text/markdown;q=0.5', `${sample}.html`],
    ['text/markdown;q=0', `${sample}.html`],
    ['text/*', `${sample}.html`],
    ['*/*', `${sample}.html`],
    [null, `${sample}.html`],
  ] as const) {
    await expectServed(await request(`${sample}.html`, accept), artifact, `Accept ${String(accept)}`);
  }
  const head = await request(sample, agentAccept, 'HEAD');
  assert.equal(head.status, 200, 'HEAD negotiation failed');
  assert(head.headers.get('content-type')?.startsWith('text/markdown'), 'HEAD did not negotiate Markdown');
  // Files that are not pages, and pages that do not exist, are never rewritten.
  const index = await request('llms.txt', 'text/markdown');
  assert.equal(index.status, 200, 'llms.txt is not served through the Worker');
  assert.equal(
    index.headers.get('content-type'),
    (await fetch(`${previewOrigin}${base}llms.txt`)).headers.get('content-type'),
  );
  assert.deepEqual(
    Buffer.from(await index.arrayBuffer()),
    await readFile(resolve(dist, 'llms.txt')),
    'llms.txt rewritten',
  );
  for (const prefix of ['', 'en/']) {
    const missing = await request(`${prefix}docs/does-not-exist-verification`, agentAccept);
    assert.equal(missing.status, 404, `Missing page under ${prefix} was negotiated instead of returning 404`);
  }
  return count;
}
