import { Button, IconButton } from '@tuuject/koi-react/button';
import { PlusIcon, SearchIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshIcon, ResetIcon } from '@/components/icons';

/**
 * One row above the allowlist: search on the start side, adding and refreshing
 * on the end side. On a narrow screen the search takes its own line. The
 * applied search lives in the URL; the field edits a draft until Enter.
 */
export function ChatsToolbar({
  search,
  onSearch,
  onAdd,
  onRefresh,
  refreshing,
}: {
  readonly search: string;
  readonly onSearch: (search: string) => void;
  readonly onAdd: () => void;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(search);
  const [seen, setSeen] = useState(search);
  // Back/Forward and deep links replace the draft with the applied search.
  if (search !== seen) {
    setSeen(search);
    setDraft(search);
  }
  return (
    <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3' })}>
      <form
        className={css({ display: 'flex', alignItems: 'center', gap: '2', flex: '1 1 240px', maxWidth: '400px' })}
        onSubmit={(event) => {
          event.preventDefault();
          onSearch(draft.trim());
        }}
      >
        <Input
          className={css({ flex: '1', minWidth: '0' })}
          aria-label={t('pages.chats.searchChats')}
          placeholder={t('pages.chats.searchChats')}
          enterKeyHint="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          iconStart={<SearchIcon />}
          dir="auto"
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
      </form>
      <div className={css({ display: 'flex', alignItems: 'center', gap: '2', marginInlineStart: 'auto' })}>
        <Button variant="outline" iconStart={<PlusIcon />} onClick={onAdd}>
          {t('pages.chats.addChat')}
        </Button>
        <IconButton
          label={t('layout.business.refreshList')}
          icon={<RefreshIcon />}
          disabled={refreshing}
          onClick={onRefresh}
        />
      </div>
    </div>
  );
}
