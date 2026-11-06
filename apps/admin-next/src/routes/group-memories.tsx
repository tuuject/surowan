import { createFileRoute } from '@tanstack/react-router';
import { chatSearch } from '@/lib/search-params';
import GroupMemoriesPage from '@/pages/group-memories';

export const Route = createFileRoute('/group-memories')({
  component: GroupMemoriesPage,
  validateSearch: chatSearch,
});
