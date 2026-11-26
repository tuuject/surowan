/**
 * Picks the decoder for a text response the way a browser does, up to its last
 * step: a byte order mark, then the Content-Type charset, then the document's
 * own declaration (an HTML `<meta>` or the XML declaration). Browsers finally
 * guess from byte frequencies; web_fetch does not guess, so a response nothing
 * declares is read as UTF-8.
 */

// The spec suggests 1024 bytes. Legacy pages often put the declaration after a
// long title or keyword list, and with no guessing to fall back on, missing it
// fails the whole page.
const HTML_PRESCAN_BYTES = 4_096;
const XML_DECLARATION_BYTES = 1_024;
const CHARSET_PARAMETER = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;"\s]+))/i;
// Only valid as the very first thing in the document.
const XML_DECLARATION = /^<\?xml\s[^>]*?\bencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/;

export interface TextEncoding {
  /** An encoding name `TextDecoder` accepts. */
  readonly encoding: string;
  /** False when nothing named the encoding and UTF-8 is only the default. */
  readonly declared: boolean;
}

export function textEncodingOf(bytes: Uint8Array, contentType: string | null): TextEncoding {
  const declared =
    byteOrderMarkEncoding(bytes) ??
    encodingForLabel(contentType === null ? undefined : charsetParameter(contentType)) ??
    documentEncoding(bytes, contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '');
  return declared === undefined ? { encoding: 'utf-8', declared: false } : { encoding: declared, declared: true };
}

function byteOrderMarkEncoding(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf-8';
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return 'utf-16be';
  }
  return bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : undefined;
}

function charsetParameter(contentType: string): string | undefined {
  const match = CHARSET_PARAMETER.exec(contentType);
  return match?.[1] ?? match?.[2];
}

function documentEncoding(bytes: Uint8Array, mediaType: string): string | undefined {
  const label =
    mediaType === 'text/html'
      ? metaCharset(latin1(bytes, HTML_PRESCAN_BYTES))
      : mediaType === 'application/xml' || mediaType === 'text/xml' || mediaType.endsWith('+xml')
        ? xmlDeclarationCharset(latin1(bytes, XML_DECLARATION_BYTES))
        : undefined;
  const encoding = encodingForLabel(label);
  // A declaration an ASCII scan could read is not really in UTF-16, and
  // x-user-defined is not meant for documents; browsers swap both the same way.
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    return 'utf-8';
  }
  return encoding === 'x-user-defined' ? 'windows-1252' : encoding;
}

function encodingForLabel(label: string | undefined): string | undefined {
  if (label === undefined) {
    return undefined;
  }
  try {
    return new TextDecoder(label).encoding;
  } catch {
    // Browsers skip unknown labels too. Node also refuses the few labels browsers
    // map to their replacement decoder (ISO-2022-KR, HZ-GB-2312), which fall through here.
    return undefined;
  }
}

/** One character per byte, so offsets match the bytes; ASCII letters lowercased like the spec compares them. */
function latin1(bytes: Uint8Array, maxBytes: number): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, maxBytes))
    .toString('latin1')
    .toLowerCase();
}

function xmlDeclarationCharset(head: string): string | undefined {
  const match = XML_DECLARATION.exec(head);
  return match?.[1] ?? match?.[2];
}

/**
 * The HTML spec's prescan for a `<meta>` charset. It skips comments and the
 * attributes of other tags, so a declaration quoted inside either is not taken.
 * `html` is already lowercased.
 */
function metaCharset(html: string): string | undefined {
  let position = 0;

  // The spec's "get an attribute"; null once the tag ends or the input runs out.
  const attribute = (): { name: string; value: string } | null => {
    while (isSpace(html[position]) || html[position] === '/') {
      position += 1;
    }
    if (position >= html.length || html[position] === '>') {
      return null;
    }
    let name = '';
    for (;;) {
      const char = html[position];
      if (char === undefined) {
        return null;
      }
      if (char === '=' && name.length > 0) {
        break;
      }
      if (isSpace(char)) {
        while (isSpace(html[position])) {
          position += 1;
        }
        if (html[position] !== '=') {
          return position >= html.length ? null : { name, value: '' };
        }
        break;
      }
      if (char === '/' || char === '>') {
        return { name, value: '' };
      }
      name += char;
      position += 1;
    }
    position += 1;
    while (isSpace(html[position])) {
      position += 1;
    }
    const quote = html[position];
    if (quote === undefined) {
      return null;
    }
    if (quote === '"' || quote === "'") {
      const end = html.indexOf(quote, position + 1);
      if (end === -1) {
        position = html.length;
        return null;
      }
      const value = html.slice(position + 1, end);
      position = end + 1;
      return { name, value };
    }
    if (quote === '>') {
      return { name, value: '' };
    }
    const start = position;
    while (position < html.length && !isSpace(html[position]) && html[position] !== '>') {
      position += 1;
    }
    return position >= html.length ? null : { name, value: html.slice(start, position) };
  };

  while (position < html.length) {
    if (html.startsWith('<!--', position)) {
      // The dashes of `<!--` count, so `<!-->` is a whole comment.
      const end = html.indexOf('-->', position + 2);
      if (end === -1) {
        return undefined;
      }
      position = end + 2;
    } else if (html.startsWith('<meta', position) && (isSpace(html[position + 5]) || html[position + 5] === '/')) {
      position += 6;
      const seen = new Set<string>();
      let gotPragma = false;
      let needPragma: boolean | undefined;
      // null: the tag named a charset no decoder knows, which also rules out its content attribute.
      let charset: string | null | undefined;
      for (let next = attribute(); next !== null; next = attribute()) {
        if (seen.has(next.name)) {
          continue;
        }
        seen.add(next.name);
        if (next.name === 'http-equiv') {
          gotPragma ||= next.value === 'content-type';
        } else if (next.name === 'charset') {
          charset = encodingForLabel(next.value) === undefined ? null : next.value;
          needPragma = false;
        } else if (next.name === 'content' && charset === undefined) {
          const label = charsetInContent(next.value);
          if (encodingForLabel(label) !== undefined) {
            charset = label;
            needPragma = true;
          }
        }
      }
      if (position >= html.length) {
        // The tag runs past the scanned bytes: its attributes may be cut short.
        return undefined;
      }
      if (typeof charset === 'string' && (needPragma === false || gotPragma)) {
        return charset;
      }
    } else if (
      html[position] === '<' &&
      (isLetter(html[position + 1]) || (html[position + 1] === '/' && isLetter(html[position + 2])))
    ) {
      while (position < html.length && !isSpace(html[position]) && html[position] !== '>') {
        position += 1;
      }
      while (attribute() !== null) {
        // Another tag's attributes are skipped whole, quoted `>` and `<meta>` included.
      }
    } else if (html.startsWith('<!', position) || html.startsWith('</', position) || html.startsWith('<?', position)) {
      position = html.indexOf('>', position + 1);
      if (position === -1) {
        return undefined;
      }
    }
    position += 1;
  }
  return undefined;
}

/** The spec's charset extraction from a `content="text/html; charset=…"` value. */
function charsetInContent(content: string): string | undefined {
  let position = 0;
  for (;;) {
    const found = content.indexOf('charset', position);
    if (found === -1) {
      return undefined;
    }
    position = found + 'charset'.length;
    while (isSpace(content[position])) {
      position += 1;
    }
    if (content[position] !== '=') {
      continue;
    }
    position += 1;
    while (isSpace(content[position])) {
      position += 1;
    }
    const quote = content[position];
    if (quote === '"' || quote === "'") {
      const end = content.indexOf(quote, position + 1);
      return end === -1 ? undefined : content.slice(position + 1, end);
    }
    const start = position;
    while (position < content.length && !isSpace(content[position]) && content[position] !== ';') {
      position += 1;
    }
    return content.slice(start, position);
  }
}

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\f' || char === '\r';
}

function isLetter(char: string | undefined): boolean {
  return char !== undefined && char >= 'a' && char <= 'z';
}
