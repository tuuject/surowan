import { Button } from '@tuuject/koi-react/button';
import { css, cx } from '@tuuject/koi-react/styled-system/css';
import JsonView from '@uiw/react-json-view';
import { darkTheme } from '@uiw/react-json-view/dark';
import { lightTheme } from '@uiw/react-json-view/light';
import type React from 'react';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/components/themes/theme-provider';
import { downloadTextFile } from '@/lib/download.ts';
import { prettyJson } from '@/lib/format';
import { LazyDetails } from './lazy-details';

/**
 * JSON viewer with a Tree / Text toggle. The tree is `@uiw/react-json-view`
 * (one level expanded, long strings shortened, copy on hover). Stored JSON is
 * untrusted content: everything renders as text nodes (no HTML execution),
 * malformed JSON falls back to the raw text, and payloads above a threshold
 * start collapsed and mount only when expanded.
 */

const DEFAULT_COLLAPSE_THRESHOLD_CHARS = 2_000;
const MAX_INLINE_STRING_CHARS = 120;

function parseJsonValue(value: string | null): unknown {
  if (value === null || value.length === 0) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isTree(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

const BOX = css({
  // Payloads are code: keys, ids and punctuation keep their LTR order in Arabic.
  direction: 'ltr',
  textAlign: 'start',
  maxHeight: '384px',
  overflow: 'auto',
  borderRadius: 'xl',
  bg: 'surface-muted',
  paddingInline: '3',
  paddingBlock: '2',
  fontFamily: 'mono',
  textStyle: 'small',
});

function JsonTree({ value }: { readonly value: object }): ReactElement {
  const { resolved } = useTheme();
  return (
    <JsonView
      value={value}
      collapsed={1}
      displayObjectSize={false}
      displayDataTypes={false}
      shortenTextAfterLength={MAX_INLINE_STRING_CHARS}
      enableClipboard
      style={
        {
          ...(resolved === 'dark' ? darkTheme : lightTheme),
          '--w-rjv-background-color': 'transparent',
          '--w-rjv-font-family': 'var(--font-mono)',
        } as React.CSSProperties
      }
    />
  );
}

export interface JsonViewerProps {
  readonly value: string | null;
  readonly title?: string;
  readonly defaultMode?: 'tree' | 'text';
  /** Start collapsed regardless of size (explicit collapse for known-huge payloads). */
  readonly initiallyCollapsed?: boolean;
  /** Payloads above this many characters start collapsed in tree mode. */
  readonly collapseThresholdChars?: number;
  /**
   * When set, the toolbar offers a download of the payload under this file
   * name. The saved bytes are the pretty-printed payload (or the raw text when
   * the stored payload is not valid JSON).
   */
  readonly downloadFileName?: string;
  readonly className?: string;
}

export function JsonViewer({
  value,
  title,
  defaultMode = 'tree',
  initiallyCollapsed = false,
  collapseThresholdChars = DEFAULT_COLLAPSE_THRESHOLD_CHARS,
  downloadFileName,
  className,
}: JsonViewerProps): ReactElement {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'tree' | 'text'>(defaultMode);
  const text = prettyJson(value);
  if (text === null) {
    return <span className={css({ color: 'text-muted' })}>—</span>;
  }
  const parsed = parseJsonValue(value);
  const canTree = isTree(parsed);
  const large = text.length > collapseThresholdChars;
  const collapsed = initiallyCollapsed || large;

  return (
    <div className={cx(css({ '& > :not(:last-child)': { marginBlockEnd: '2' } }), className)}>
      <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1' })}>
        <Button
          size="sm"
          variant={mode === 'tree' ? 'soft' : 'ghost'}
          color="secondary"
          aria-pressed={mode === 'tree'}
          disabled={!canTree}
          onClick={() => setMode('tree')}
        >
          {t('layout.business.tree')}
        </Button>
        <Button
          size="sm"
          variant={mode === 'text' ? 'soft' : 'ghost'}
          color="secondary"
          aria-pressed={mode === 'text'}
          onClick={() => setMode('text')}
        >
          {t('layout.business.text')}
        </Button>
        {title !== undefined ? <span className={css({ textStyle: 'small', color: 'text-muted' })}>{title}</span> : null}
        {collapsed ? (
          <span className={css({ textStyle: 'small', color: 'text-muted' })}>
            {t('layout.business.chars', { n: text.length })}
          </span>
        ) : null}
        {downloadFileName !== undefined ? (
          <Button
            size="sm"
            variant="ghost"
            color="secondary"
            onClick={() => downloadTextFile(downloadFileName, text, 'application/json;charset=utf-8')}
          >
            {t('layout.business.downloadJson')}
          </Button>
        ) : null}
      </div>
      {mode === 'tree' && canTree ? (
        collapsed ? (
          <LazyDetails summary={t('layout.business.payloadSummary', { n: text.length })}>
            <div className={BOX}>
              <JsonTree value={parsed} />
            </div>
          </LazyDetails>
        ) : (
          <div className={BOX}>
            <JsonTree value={parsed} />
          </div>
        )
      ) : (
        <pre className={cx(BOX, css({ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }))}>{text}</pre>
      )}
    </div>
  );
}
