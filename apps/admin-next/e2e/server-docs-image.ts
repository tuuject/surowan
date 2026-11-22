/**
 * The docs suite's image upstream: the OpenRouter image catalog and images
 * endpoint answered from this process, so the image screenshots run on a real
 * `ImageService`, a real worker and a real record without reaching the network.
 *
 * What is faked is only the vendor: the two catalog URLs and `POST /api/v1/images`
 * are answered here (a small deterministic illustration, base64-encoded, the
 * shape the OpenRouter adapter reads). Every other request keeps the process's
 * ordinary `fetch`, which is how the fixture's providers keep talking to the
 * loopback relay. Nothing here runs unless `E2E_SEED_LOCALE` asked for the docs
 * seed.
 */
import sharp from 'sharp';

/** The only hosts the panel's server side may still call: this fixture's own loopback. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const CATALOG_URL = 'https://openrouter.ai/api/v1/images/models';
const IMAGES_URL = 'https://openrouter.ai/api/v1/images';

/** The one catalog entry: what the settings picker lists and the config names. */
export const DOCS_IMAGE_CATALOG = {
  id: 'google/gemini-3.1-flash-image',
  name: 'Nano Banana 2',
  providerTag: 'google-ai-studio',
  providerName: 'Google AI Studio',
} as const;

/** The illustration every docs generation receives: a simple night landscape. */
function illustrationSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="384" viewBox="0 0 512 384">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#cfe4f5"/>
        <stop offset="1" stop-color="#f4ecdd"/>
      </linearGradient>
    </defs>
    <rect width="512" height="384" fill="url(#sky)"/>
    <circle cx="368" cy="104" r="46" fill="#f2d8a8"/>
    <path d="M0 300 L120 210 L210 286 L300 196 L420 300 L512 250 L512 384 L0 384 Z" fill="#9db6c8"/>
    <path d="M0 330 L150 270 L280 330 L400 280 L512 330 L512 384 L0 384 Z" fill="#7d97ab"/>
  </svg>`;
}

/** The illustration's base64 bytes; the specs upload it as the reference image. */
export async function docsIllustration(): Promise<string> {
  const png = await sharp(Buffer.from(illustrationSvg())).png().toBuffer();
  return png.toString('base64');
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'docs-image-fixture' },
  });
}

/**
 * Installs the docs image upstream over the process's `fetch` and returns the
 * base64 illustration (the specs upload it as the reference image).
 */
export async function installDocsImageUpstream(): Promise<{ readonly illustration: string }> {
  const original = globalThis.fetch;
  const illustration = await docsIllustration();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // `init` wins over the Request's own method, exactly as `fetch` resolves it.
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    if (url.startsWith(CATALOG_URL)) {
      const modelId = url
        .slice(CATALOG_URL.length)
        .replace(/^\//, '')
        .replace(/\/endpoints$/, '');
      if (url.endsWith('/endpoints')) {
        if (modelId !== DOCS_IMAGE_CATALOG.id) {
          return new Response(JSON.stringify({ error: { message: 'unknown model' } }), { status: 404 });
        }
        return json({
          id: modelId,
          endpoints: [
            {
              provider_name: DOCS_IMAGE_CATALOG.providerName,
              provider_tag: DOCS_IMAGE_CATALOG.providerTag,
              supported_parameters: {
                aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] },
                quality: { type: 'enum', values: ['auto'] },
                output_format: { type: 'enum', values: ['png'] },
                input_references: { type: 'range', min: 0, max: 14 },
                n: { type: 'range', min: 1, max: 1 },
              },
            },
          ],
        });
      }
      if (modelId.length > 0) {
        return new Response(JSON.stringify({ error: { message: 'unknown model' } }), { status: 404 });
      }
      return json({
        data: [
          {
            id: DOCS_IMAGE_CATALOG.id,
            name: DOCS_IMAGE_CATALOG.name,
            architecture: { output_modalities: ['image'] },
          },
        ],
      });
    }
    if (url === IMAGES_URL && method === 'POST') {
      return json({ id: 'docs-generation-fixture', data: [{ b64_json: illustration, media_type: 'image/png' }] });
    }
    // Everything else is a real request from the panel's server side (the
    // loopback relay, the MCP fixtures, storage). The docs suite must never
    // reach the network from here either: the browser-side route guard cannot
    // see these. Redirects are refused rather than followed, so an allowed
    // loopback origin cannot hand the request to another host.
    const target = new URL(url);
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error(`docs fixture refuses ${method} ${target.origin}${target.pathname}`);
    }
    const response = await original(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error(`docs fixture refuses a redirect from ${target.href}`);
    }
    return response;
  }) as typeof fetch;
  return { illustration };
}
