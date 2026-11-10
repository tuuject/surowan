import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import MemoriesPage from '@/pages/memories';

export const Route = createFileRoute('/memories')({
  component: MemoriesPage,
  validateSearch: listQuerySearch,
});
