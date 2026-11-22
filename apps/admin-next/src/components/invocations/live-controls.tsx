import { css } from '@tuuject/koi-react/styled-system/css';
import { Switch } from '@tuuject/koi-react/switch';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SAFE_BOTTOM, STICKY_BAR_Z_INDEX } from '@/components/app-shell/shared';
import { AutoRefreshSwitch } from '@/components/invocations/auto-refresh-switch';
import { useUiStore } from '@/stores/ui';

/** The document is the panel's scroller (`html` scrolls, see globals.css), so its end is the page's end. */
function scrollPageToBottom(): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: reduced ? 'instant' : 'smooth' });
}

function scrollOnAttach(node: HTMLSpanElement | null): void {
  if (node !== null) {
    scrollPageToBottom();
  }
}

/**
 * Scrolls to the bottom each time `value` changes while following is on. Every
 * change mounts a fresh anchor, and its ref runs once React has committed the
 * new rows, so the height it scrolls to already includes them. The first value
 * only marks where following starts: opening a page never jumps on its own, and
 * a change seen while following was off is not caught up later.
 */
function FollowChanges({ value, enabled }: { readonly value: unknown; readonly enabled: boolean }) {
  const [seen, setSeen] = useState(value);
  const [changes, setChanges] = useState(0);
  if (value !== seen) {
    setSeen(value);
    if (enabled) {
      setChanges(changes + 1);
    }
  }
  return changes === 0 ? null : <span key={changes} ref={scrollOnAttach} hidden />;
}

/**
 * The Invocation detail page's live controls, floating over the page while it
 * scrolls and settling after the last section, like the settings save bar.
 * `invocation` is the query's data: structural sharing keeps the same object
 * until a refetch brings something new, which is what Auto scroll follows.
 */
export function InvocationLiveControls({ invocation }: { readonly invocation: object }): ReactElement {
  const { t } = useTranslation();
  const autoScroll = useUiStore((state) => state.invocationAutoScroll);
  const setAutoScroll = useUiStore((state) => state.setInvocationAutoScroll);
  return (
    <div
      className={css({
        position: 'sticky',
        bottom: `calc(token(spacing.4) + ${SAFE_BOTTOM})`,
        zIndex: STICKY_BAR_Z_INDEX,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: '6',
        rowGap: '2',
        width: 'fit-content',
        maxWidth: '100%',
        marginInlineStart: 'auto',
        paddingBlock: '3',
        paddingInline: '5',
        borderRadius: 'bar',
        bg: 'surface-glass-tint',
        backdropFilter: 'blur(var(--blurs-float))',
        boxShadow: 'float',
      })}
    >
      <AutoRefreshSwitch />
      <Switch
        label={t('layout.business.autoScroll')}
        checked={autoScroll}
        onCheckedChange={(checked) => {
          setAutoScroll(checked);
          if (checked) {
            scrollPageToBottom();
          }
        }}
      />
      <FollowChanges value={invocation} enabled={autoScroll} />
    </div>
  );
}
