import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import InvocationsPage from '@/pages/invocations';

export const Route = createFileRoute('/invocations')({
  component: InvocationsPage,
  validateSearch: listQuerySearch,
});
