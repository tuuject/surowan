import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import ContextsPage from '@/pages/contexts';

export const Route = createFileRoute('/contexts')({
  component: ContextsPage,
  validateSearch: listQuerySearch,
});
