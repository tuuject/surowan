import { createFileRoute } from '@tanstack/react-router';
import GroupMemoriesPage from '@/pages/group-memories';
import { chatSearch } from '@/lib/search-params';

export const Route = createFileRoute('/group-memories')({
  component: GroupMemoriesPage,
  validateSearch: chatSearch,
});
