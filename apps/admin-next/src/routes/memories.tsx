import { createFileRoute } from '@tanstack/react-router';
import MemoriesPage from '@/pages/memories';
import { chatSearch } from '@/lib/search-params';

export const Route = createFileRoute('/memories')({
  component: MemoriesPage,
  validateSearch: chatSearch,
});
