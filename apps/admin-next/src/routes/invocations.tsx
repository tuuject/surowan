import { createFileRoute } from '@tanstack/react-router';
import { chatSearch } from '@/lib/search-params';
import InvocationsPage from '@/pages/invocations';

export const Route = createFileRoute('/invocations')({
  component: InvocationsPage,
  validateSearch: chatSearch,
});
