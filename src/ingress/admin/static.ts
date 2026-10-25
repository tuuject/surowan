import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { SECURITY_HEADERS, json } from './http.ts';

const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/vnd.microsoft.icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function asset(body: Buffer, path: string): Response {
  const extension = path.slice(path.lastIndexOf('.'));
  const isHtml = extension === '.html';
  const headers = new Headers({
    ...SECURITY_HEADERS,
    'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'cache-control': isHtml ? 'no-store' : 'public, max-age=3600',
  });
  return new Response(new Uint8Array(body), { headers });
}

async function readAsset(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export interface StaticAssetDeps {
  /** The built `apps/admin-next/dist` directory, already resolved. */
  readonly staticDir: string;
}

/** `/` and every non-`/api` path: the built panel bundle, with an SPA fallback. */
export function createStaticAssetHandler(deps: StaticAssetDeps) {
  const { staticDir } = deps;

  return async function handle(request: Request, segments: readonly string[]): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method_not_allowed', message: 'Only GET and HEAD are supported' }, 405);
    }
    const relative = segments.length === 0 ? 'index.html' : segments.join('/');
    const candidate = resolve(staticDir, relative);
    if (candidate !== staticDir && !candidate.startsWith(staticDir + sep)) {
      return json({ error: 'not_found', message: 'Asset does not exist' }, 404);
    }
    const direct = await readAsset(candidate);
    if (direct !== undefined) {
      return asset(direct, candidate);
    }
    const indexPath = join(staticDir, 'index.html');
    const index = await readAsset(indexPath);
    if (index !== undefined) {
      return asset(index, indexPath);
    }
    return json(
      {
        error: 'admin_bundle_missing',
        message: `Admin bundle is absent: ${staticDir}. Run pnpm run admin:build.`,
      },
      503,
    );
  };
}
