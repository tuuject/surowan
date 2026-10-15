import { createFileRoute } from '@tanstack/react-router';
import InvocationsPage from '@/pages/invocations';
import { chatSearch } from '@/lib/search-params';

export const Route = createFileRoute('/invocations')({
  component: InvocationsPage,
  validateSearch: chatSearch,
});
