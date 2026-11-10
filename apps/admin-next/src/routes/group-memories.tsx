import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import GroupMemoriesPage from '@/pages/group-memories';

export const Route = createFileRoute('/group-memories')({
  component: GroupMemoriesPage,
  validateSearch: listQuerySearch,
});
