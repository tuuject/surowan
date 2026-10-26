import { createFileRoute } from '@tanstack/react-router';
import SearchSettingsPage from '@/pages/search-settings';

export const Route = createFileRoute('/search-settings')({
  component: SearchSettingsPage,
});
