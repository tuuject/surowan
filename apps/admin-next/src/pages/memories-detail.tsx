import { css } from '@tuuject/koi-react/styled-system/css';
import { memoryBlobContentPath } from '@/lib/api/memories.ts';

type DetailPart = { readonly key: string } & (
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly id: string; readonly alt: string }
  | { readonly kind: 'link'; readonly id: string }
);

/**
 * The detail is Markdown stored by the model. Only `pwblob://` references are
 * special-cased: Markdown images become panel-session image requests and any
 * remaining reference becomes a link. Everything else stays literal text.
 */
const DETAIL_BLOB_PATTERN = /!\[([^\]]*)\]\(pwblob:\/\/(blb_[a-f0-9]{32})\)|pwblob:\/\/(blb_[a-f0-9]{32})/g;

function splitDetail(detail: string): readonly DetailPart[] {
  const parts: DetailPart[] = [];
  let last = 0;
  for (const match of detail.matchAll(DETAIL_BLOB_PATTERN)) {
    const index = match.index;
    if (index > last) {
      parts.push({ key: `part-${parts.length}`, kind: 'text', text: detail.slice(last, index) });
    }
    const imageId = match[2];
    if (imageId !== undefined) {
      parts.push({ key: `part-${parts.length}`, kind: 'image', id: imageId, alt: match[1] ?? '' });
    } else {
      const linkId = match[3];
      if (linkId !== undefined) {
        parts.push({ key: `part-${parts.length}`, kind: 'link', id: linkId });
      }
    }
    last = index + match[0].length;
  }
  if (last < detail.length) {
    parts.push({ key: `part-${parts.length}`, kind: 'text', text: detail.slice(last) });
  }
  return parts;
}

export function MemoryDetail({ detail }: { readonly detail: string }): React.ReactElement {
  return (
    <div
      className={css({
        textStyle: 'body',
        '& > :not(:last-child)': { marginBlockEnd: '2' },
        overflowWrap: 'anywhere',
        whiteSpace: 'pre-wrap',
      })}
    >
      {splitDetail(detail).map((part) => {
        if (part.kind === 'text') {
          return <span key={part.key}>{part.text}</span>;
        }
        if (part.kind === 'image') {
          return (
            <img
              key={part.key}
              src={memoryBlobContentPath(part.id)}
              alt={part.alt}
              loading="lazy"
              className={css({
                maxHeight: '320px',
                maxWidth: '100%',
                borderRadius: 'lg',
                borderWidth: '1px',
                borderColor: 'border',
              })}
            />
          );
        }
        return (
          <a
            key={part.key}
            href={memoryBlobContentPath(part.id)}
            target="_blank"
            rel="noreferrer"
            className={css({ color: 'text-brand', textDecorationLine: 'underline', wordBreak: 'break-all' })}
          >
            {`pwblob://${part.id}`}
          </a>
        );
      })}
    </div>
  );
}
