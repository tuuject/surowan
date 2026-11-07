import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import PromptsPage from '@/pages/prompts';

export const Route = createFileRoute('/prompts')({
  component: PromptsPage,
  validateSearch: listQuerySearch,
});
