import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import ModelsPage from '@/pages/models';

export const Route = createFileRoute('/models')({
  component: ModelsPage,
  validateSearch: listQuerySearch,
});
