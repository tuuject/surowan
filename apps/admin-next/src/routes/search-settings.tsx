import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import SearchSettingsPage from '@/pages/search-settings';

export const Route = createFileRoute('/search-settings')({
  component: SearchSettingsPage,
  validateSearch: listQuerySearch,
});
