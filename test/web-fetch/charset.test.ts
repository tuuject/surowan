import { afterAll, expect, test } from 'vitest';
import { createWebFetchTool } from '../../src/plugins/web-fetch/web-fetch.ts';
import { createToolAudit } from '../../src/store/tool-audit.ts';
import { cleanupWebFetchDirectories, type Fixture, fixture } from './fixtures.ts';

afterAll(cleanupWebFetchDirectories);

// Spelled out byte by byte: Node decodes these charsets but cannot encode them.
const GBK_BOWL_NOTES = [0xcd, 0xeb, 0xb5, 0xc4, 0xcb, 0xb5, 0xc3, 0xf7]; // 碗的说明
const GBK_HELLO = [0xc4, 0xe3, 0xba, 0xc3]; // 你好
const GBK_BOWL = [0xcd, 0xeb]; // 碗
const SJIS_NIHONGO = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]; // 日本語
const BIG5_ZHONGWEN = [0xa4, 0xa4, 0xa4, 0xe5]; // 中文
const CP1251_PRIVET = [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]; // Привет
const EUCKR_HANGUGEO = [0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee]; // 한국어
const TRUNCATION_MARKER = '\n[content truncated]';

/** ASCII strings stay as written; number arrays and buffers are raw bytes. */
function bytes(...parts: readonly (string | readonly number[] | Buffer)[]): Buffer {
  return Buffer.concat(
    parts.map((part) =>
      typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.isBuffer(part) ? part : Buffer.from(part),
    ),
  );
}

function repeat(part: readonly number[], times: number): number[] {
  return Array.from({ length: times }, () => part).flat();
}

type Pages = Record<string, { readonly contentType: string | null; readonly body: Buffer }>;

function toolFor({ store, context }: Fixture, pages: Pages) {
  return createWebFetchTool({
    audit: createToolAudit(store, context.invocationId),
    invocationDeadline: Date.now() + 30_000,
    resolveHostname: async () => [{ address: '203.0.114.10', family: 4 }],
    requestResolved: async (url) => {
      const page = pages[url.pathname];
      if (page === undefined) {
        return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
      }
      return new Response(page.body, {
        status: 200,
        headers: page.contentType === null ? {} : { 'content-type': page.contentType },
      });
    },
  });
}

async function fetchText(
  tool: ReturnType<typeof toolFor>,
  id: string,
  path: string,
  raw = true,
): Promise<{ text: string; truncated: boolean }> {
  const result = await tool.execute(id, { url: `https://legacy.example${path}`, raw });
  return {
    text: result.content[0]?.type === 'text' ? result.content[0].text : '',
    truncated: result.details.truncated,
  };
}

function body(text: string): string {
  return text.slice(text.indexOf('\n', text.indexOf('Content-Type:')) + 1);
}

function auditRows({ store }: Fixture) {
  return store.db
    .prepare<[], { tool_call_id: string; state: string; error_code: string | null; result_text: string | null }>(
      'SELECT tool_call_id, state, error_code, result_text FROM tool_calls ORDER BY id',
    )
    .all();
}

test('web_fetch decodes a page in the charset its Content-Type names and audits the decoded text', async () => {
  const run = await fixture();
  try {
    const tool = toolFor(run, {
      '/gbk': {
        contentType: 'text/html; charset=GBK',
        body: bytes(
          '<html><head><title>',
          GBK_BOWL_NOTES,
          '</title></head><body><article><h1>',
          GBK_BOWL_NOTES,
          '</h1><p>A plastic bowl is light, cheap and hard to break. ',
          GBK_HELLO,
          '</p></article></body></html>',
        ),
      },
      // Quoted, and spelled with an alias WHATWG maps to windows-1251.
      '/cp1251': { contentType: 'text/plain; charset="cp1251"', body: bytes(CP1251_PRIVET) },
      '/big5': { contentType: 'text/plain;charset=BIG5', body: bytes(BIG5_ZHONGWEN) },
    });
    const gbk = await fetchText(tool, 'web-gbk', '/gbk', false);
    expect(gbk.text).toContain('Content-Type: text/html; charset=GBK');
    expect(gbk.text).toContain('Title: 碗的说明');
    expect(gbk.text).toContain('A plastic bowl is light, cheap and hard to break. 你好');
    expect(gbk.text).not.toContain('�');
    expect(body((await fetchText(tool, 'web-cp1251', '/cp1251')).text)).toBe('Привет');
    expect(body((await fetchText(tool, 'web-big5', '/big5')).text)).toBe('中文');
    const rows = auditRows(run);
    expect(rows.map(({ state, error_code }) => [state, error_code])).toEqual([
      ['success', null],
      ['success', null],
      ['success', null],
    ]);
    expect(rows[0]?.result_text).toBe(gbk.text);
  } finally {
    run.store.close();
  }
});

test('web_fetch reads the charset an HTML page declares in a meta tag when the header names none', async () => {
  const run = await fixture();
  try {
    const tool = toolFor(run, {
      '/meta-charset': {
        contentType: 'text/html',
        body: bytes('<html><head><meta charset="Shift_JIS"><title>', SJIS_NIHONGO, '</title></head></html>'),
      },
      '/http-equiv': {
        contentType: 'text/html',
        body: bytes(
          '<html><head><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=gb2312"><title>',
          GBK_BOWL_NOTES,
          '</title></head></html>',
        ),
      },
      // A declaration inside a comment, or inside another tag's attribute, is not one.
      '/decoys': {
        contentType: 'text/html',
        body: bytes(
          // The `>` before it would end a bogus `<!…>` comment and expose the commented-out tag.
          '<html><head><!-- a > b: <meta charset="big5"> --><a title="<meta charset=big5>"></a>',
          '<meta name=description content="charset=big5"><meta charset=gbk><title>',
          GBK_BOWL_NOTES,
          '</title></head></html>',
        ),
      },
      // A page found by an ASCII scan cannot really be UTF-16: browsers read it as UTF-8.
      '/utf16-meta': {
        contentType: 'text/html',
        body: bytes('<html><head><meta charset="utf-16"><title>', Buffer.from('碗的说明'), '</title></head></html>'),
      },
      // An unknown header label is skipped, so the page's own declaration decides.
      '/bogus-header': {
        contentType: 'text/html; charset=bogus',
        body: bytes('<html><head><meta charset="big5"><title>', BIG5_ZHONGWEN, '</title></head></html>'),
      },
      // Long legacy heads put the declaration past the spec's 1024 bytes.
      '/late-meta': {
        contentType: 'text/html',
        body: bytes(
          `<html><head><meta name="keywords" content="${'bowl,'.repeat(300)}">`,
          '<meta http-equiv="Content-Type" content="text/html; charset=gbk"><title>',
          GBK_BOWL_NOTES,
          '</title></head></html>',
        ),
      },
    });
    expect(body((await fetchText(tool, 'web-meta', '/meta-charset')).text)).toBe(
      '<html><head><meta charset="Shift_JIS"><title>日本語</title></head></html>',
    );
    expect(body((await fetchText(tool, 'web-equiv', '/http-equiv')).text)).toContain('<title>碗的说明</title>');
    expect(body((await fetchText(tool, 'web-decoys', '/decoys')).text)).toContain('<title>碗的说明</title>');
    expect(body((await fetchText(tool, 'web-utf16-meta', '/utf16-meta')).text)).toContain('<title>碗的说明</title>');
    expect(body((await fetchText(tool, 'web-bogus', '/bogus-header')).text)).toContain('<title>中文</title>');
    expect(body((await fetchText(tool, 'web-late', '/late-meta')).text)).toContain('<title>碗的说明</title>');
    expect(auditRows(run).every(({ state }) => state === 'success')).toBe(true);
  } finally {
    run.store.close();
  }
});

test('web_fetch lets a byte order mark beat the header, and the header beat the page', async () => {
  const run = await fixture();
  try {
    const tool = toolFor(run, {
      '/utf8-bom': {
        contentType: 'text/plain; charset=gbk',
        body: bytes([0xef, 0xbb, 0xbf], Buffer.from('碗的说明')),
      },
      '/utf16-bom': {
        contentType: 'text/plain',
        body: bytes([0xff, 0xfe], Buffer.from('碗的说明 bowl', 'utf16le')),
      },
      '/header-over-meta': {
        contentType: 'text/html; charset=windows-1251',
        body: bytes('<html><head><meta charset="gbk"><title>', CP1251_PRIVET, '</title></head></html>'),
      },
    });
    // The mark picks the decoder and is not part of the text.
    expect(body((await fetchText(tool, 'web-utf8-bom', '/utf8-bom')).text)).toBe('碗的说明');
    expect(body((await fetchText(tool, 'web-utf16-bom', '/utf16-bom')).text)).toBe('碗的说明 bowl');
    expect(body((await fetchText(tool, 'web-header', '/header-over-meta')).text)).toContain('<title>Привет</title>');
  } finally {
    run.store.close();
  }
});

test('web_fetch decodes XML in the encoding its declaration names', async () => {
  const run = await fixture();
  try {
    const tool = toolFor(run, {
      '/feed': {
        contentType: 'application/rss+xml',
        body: bytes(
          "<?xml version='1.0' encoding='EUC-KR'?><rss><channel><title>",
          EUCKR_HANGUGEO,
          '</title></channel></rss>',
        ),
      },
    });
    const feed = await tool.execute('web-feed', { url: 'https://legacy.example/feed' });
    const text = feed.content[0]?.type === 'text' ? feed.content[0].text : '';
    expect(body(text)).toBe(
      "<?xml version='1.0' encoding='EUC-KR'?><rss><channel><title>한국어</title></channel></rss>",
    );
    expect(feed.details).toMatchObject({ format: 'raw', truncated: false });
  } finally {
    run.store.close();
  }
});

test('web_fetch replaces bytes a declared charset cannot decode instead of failing the page', async () => {
  const run = await fixture();
  try {
    const tool = toolFor(run, {
      // 0x81 opens a two-byte Shift_JIS character that the following space cannot finish.
      '/broken': {
        contentType: 'text/plain; charset=shift_jis',
        body: bytes([0x93, 0xfa, 0x96, 0x7b, 0x81], ' ', [0x8c, 0xea]),
      },
      '/broken-utf8': { contentType: 'text/plain; charset=utf-8', body: bytes('bowl ', [0xc4, 0xe3], ' end') },
    });
    expect(body((await fetchText(tool, 'web-broken', '/broken')).text)).toBe('日本� 語');
    expect(body((await fetchText(tool, 'web-broken-utf8', '/broken-utf8')).text)).toBe('bowl �� end');
    expect(auditRows(run).map(({ state }) => state)).toEqual(['success', 'success']);
  } finally {
    run.store.close();
  }
});

test('web_fetch still rejects text that declares no charset and is not UTF-8', async () => {
  const run = await fixture();
  try {
    const tool = toolFor(run, {
      '/undeclared-gbk': { contentType: 'text/plain', body: bytes(GBK_BOWL_NOTES) },
      '/untyped-binary': { contentType: null, body: bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]) },
    });
    await expect(fetchText(tool, 'web-undeclared', '/undeclared-gbk')).rejects.toThrow(
      'web_fetch failed: Response is not valid UTF-8 and declares no charset',
    );
    await expect(fetchText(tool, 'web-untyped', '/untyped-binary')).rejects.toThrow(
      'web_fetch failed: Response is not valid UTF-8 and declares no charset',
    );
    expect(auditRows(run).map(({ state, error_code }) => [state, error_code])).toEqual([
      ['error', 'invalid_text_encoding'],
      ['error', 'invalid_text_encoding'],
    ]);
  } finally {
    run.store.close();
  }
});

test('web_fetch keeps decoded legacy text inside the result budget', async () => {
  const run = await fixture();
  try {
    const tool = toolFor(run, {
      // One byte each on the wire, three bytes each once decoded.
      '/euro': { contentType: 'text/plain; charset=windows-1252', body: bytes(repeat([0x80], 40_000)) },
      '/bowls': { contentType: 'text/plain; charset=gbk', body: bytes(repeat(GBK_BOWL, 20_000)) },
    });
    const euro = await fetchText(tool, 'web-euro', '/euro');
    expect(Buffer.byteLength(euro.text)).toBeLessThanOrEqual(32_768);
    expect(euro.text.endsWith(`€${TRUNCATION_MARKER}`)).toBe(true);
    expect(euro.truncated).toBe(true);
    const bowls = await fetchText(tool, 'web-bowls', '/bowls');
    expect(Buffer.byteLength(bowls.text)).toBeLessThanOrEqual(32_768);
    expect(bowls.text.endsWith(`碗${TRUNCATION_MARKER}`)).toBe(true);
    expect(bowls.truncated).toBe(true);
    expect(auditRows(run).map(({ result_text }) => result_text)).toEqual([euro.text, bowls.text]);
  } finally {
    run.store.close();
  }
});

test('web_fetch drops a character the read limit cut in half instead of failing or replacing it', async () => {
  const run = await fixture();
  try {
    const utf16 = { contentType: 'text/plain', body: bytes([0xff, 0xfe], Buffer.from('a'.repeat(40_000), 'utf16le')) };
    const utf8 = { contentType: 'text/plain', body: Buffer.from('碗'.repeat(20_000)) };
    // The URL is part of the header lines, so each extra letter moves the read limit
    // by one byte; together the paths land the cut on every offset within a character.
    const tool = toolFor(run, {
      '/u': utf16,
      '/uu': utf16,
      '/b': utf8,
      '/bb': utf8,
      '/bbb': utf8,
    });
    for (const path of ['/u', '/uu']) {
      const result = await fetchText(tool, `web-utf16${path}`, path);
      expect(result.text.endsWith(`a${TRUNCATION_MARKER}`)).toBe(true);
      expect(result.text).not.toContain('�');
      expect(result.truncated).toBe(true);
    }
    for (const path of ['/b', '/bb', '/bbb']) {
      const result = await fetchText(tool, `web-utf8${path}`, path);
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(32_768);
      expect(result.text.endsWith(`碗${TRUNCATION_MARKER}`)).toBe(true);
      expect(result.truncated).toBe(true);
    }
    expect(auditRows(run).every(({ state }) => state === 'success')).toBe(true);
  } finally {
    run.store.close();
  }
});
