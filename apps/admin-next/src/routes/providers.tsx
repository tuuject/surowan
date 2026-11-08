import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import ProvidersPage from '@/pages/providers';

export const Route = createFileRoute('/providers')({
  component: ProvidersPage,
  validateSearch: listQuerySearch,
});
