import { createFileRoute } from '@tanstack/react-router';
import { chatSearch } from '@/lib/search-params';
import MemoriesPage from '@/pages/memories';

export const Route = createFileRoute('/memories')({
  component: MemoriesPage,
  validateSearch: chatSearch,
});
