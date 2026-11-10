import { Badge } from '@tuuject/koi-react/badge';
import { IconButton } from '@tuuject/koi-react/button';
import { SearchIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { focusRing } from '@/components/app-shell/shared';
import { MonoValue } from '@/components/business';
import { RefreshIcon, ResetIcon } from '@/components/icons';
import type { ChatEntry } from '@/lib/api/chats.ts';

/**
 * The prompt scope selector: a search box with the global prompt above every
 * configured Chat. Selecting a row is the only navigation on the page; the
 * detail beside it owns every read and write. `selectedChat` is the config
 * Chat ID, or null for the global scope; a deep-linked Chat that the list does
 * not contain still gets its own row so the active scope is never invisible.
 */
export function PromptScopeRail({
  chats,
  selectedChat,
  search,
  onSearch,
  onSelect,
  onRefresh,
  refreshing,
  loading,
}: {
  readonly chats: readonly ChatEntry[];
  readonly selectedChat: string | null;
  readonly search: string;
  readonly onSearch: (search: string) => void;
  readonly onSelect: (chatId: string | null) => void;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
  readonly loading: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const missingChat = selectedChat !== null && !chats.some((chat) => chat.id === selectedChat);
  const needle = search.trim().toLowerCase();
  const listed =
    needle.length === 0
      ? chats
      : chats.filter((chat) => chat.id.includes(needle) || (chat.title ?? '').toLowerCase().includes(needle));

  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: '4',
        flex: '1 1 auto',
        minWidth: '0',
        minHeight: '0',
      })}
    >
      <PromptScopeSearch search={search} onSearch={onSearch} onRefresh={onRefresh} refreshing={refreshing} />
      {/*
       * The parent caps the rail's height (the sticky desktop column), so only
       * the list scrolls: the search box stays put. The 4px padding, cancelled
       * by the margin, keeps the rows' focus outline inside the clip, and the
       * hairlines mark a scroll edge only while rows are hidden past it.
       */}
      <nav
        aria-label={t('pages.prompts.railLabel')}
        className={css({
          flex: '1 1 auto',
          minHeight: '0',
          overflowY: 'auto',
          padding: '1',
          margin: '-1',
          // One literal: Panda extracts styles statically and drops computed values.
          backgroundImage:
            'linear-gradient(token(colors.page-bg), token(colors.page-bg)), linear-gradient(token(colors.page-bg), token(colors.page-bg)), linear-gradient(token(colors.divider), token(colors.divider)), linear-gradient(token(colors.divider), token(colors.divider))',
          backgroundSize: '100% 4px, 100% 4px, 100% 1px, 100% 1px',
          backgroundPosition: 'top, bottom, top, bottom',
          backgroundRepeat: 'no-repeat',
          backgroundAttachment: 'local, local, scroll, scroll',
        })}
      >
        <ul className={css({ display: 'flex', flexDirection: 'column', gap: '1', margin: '0', padding: '0' })}>
          <PromptScopeRow
            label={t('pages.prompts.globalScope')}
            detail={t('pages.prompts.globalScopeSummary')}
            selected={selectedChat === null}
            onSelect={() => onSelect(null)}
          />
          {missingChat && selectedChat !== null ? (
            <PromptScopeRow
              label={t('pages.prompts.chatScope', { id: selectedChat })}
              detail={<MonoValue value={selectedChat} />}
              selected
              onSelect={() => onSelect(selectedChat)}
            />
          ) : null}
          {listed.map((chat) => (
            <PromptScopeRow
              key={chat.id}
              label={chat.title ?? t('pages.prompts.chatScope', { id: chat.id })}
              detail={
                <>
                  <MonoValue value={chat.id} />
                  <Badge tone={'primary'}>
                    {chat.type ?? (chat.id.startsWith('-') ? t('pages.chats.group') : t('pages.chats.private'))}
                  </Badge>
                </>
              }
              selected={selectedChat === chat.id}
              onSelect={() => onSelect(chat.id)}
            />
          ))}
        </ul>
        {loading ? (
          <p className={css({ margin: '0', paddingInline: '4', paddingBlock: '3', color: 'text-muted' })}>
            {t('common.loading')}
          </p>
        ) : listed.length === 0 ? (
          <p className={css({ margin: '0', paddingInline: '4', paddingBlock: '3', color: 'text-muted' })}>
            {chats.length === 0 ? t('pages.chats.emptyChats') : t('pages.prompts.noMatchingChats')}
          </p>
        ) : null}
      </nav>
    </div>
  );
}

function PromptScopeRow({
  label,
  detail,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly detail: ReactNode;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  return (
    <li className={css({ listStyle: 'none' })}>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={css({
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: '1',
          width: '100%',
          padding: '3',
          border: 'none',
          borderRadius: 'xl',
          bg: 'transparent',
          color: 'nav-item-text',
          textAlign: 'left',
          cursor: 'pointer',
          transitionProperty: 'background-color, color',
          transitionDuration: 'fast',
          _hover: { bg: 'nav-item-hover' },
          _focusVisible: focusRing,
          '&[aria-pressed=true]': { bg: 'nav-item-active', color: 'text' },
        })}
      >
        <span className={css({ minWidth: '0', overflowWrap: 'anywhere' })}>{label}</span>
        <span
          className={css({
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            columnGap: '2',
            rowGap: '1',
            textStyle: 'small',
            color: 'text-muted',
          })}
        >
          {detail}
        </span>
      </button>
    </li>
  );
}

/** Applied conditions stay in the URL; the field edits a draft until Enter. */
function PromptScopeSearch({
  search,
  onSearch,
  onRefresh,
  refreshing,
}: {
  readonly search: string;
  readonly onSearch: (search: string) => void;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(search);
  const [seen, setSeen] = useState(search);
  if (search !== seen) {
    setSeen(search);
    setDraft(search);
  }

  return (
    <form
      className={css({ display: 'flex', flexShrink: '0', alignItems: 'center', gap: '2' })}
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(draft);
      }}
    >
      <Input
        className={css({ flex: '1', minWidth: '0' })}
        aria-label={t('pages.prompts.searchScopes')}
        placeholder={t('pages.prompts.searchScopes')}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        iconStart={<SearchIcon />}
      />
      {search.length === 0 ? null : (
        <IconButton
          type="button"
          variant="ghost"
          color="secondary"
          label={t('layout.business.clearFilter')}
          icon={<ResetIcon />}
          onClick={() => {
            setDraft('');
            onSearch('');
          }}
        />
      )}
      <IconButton
        type="button"
        variant="ghost"
        color="secondary"
        label={t('pages.prompts.refreshChats')}
        icon={<RefreshIcon />}
        disabled={refreshing}
        onClick={onRefresh}
      />
    </form>
  );
}
