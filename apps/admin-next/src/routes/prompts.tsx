import { createFileRoute } from '@tanstack/react-router';
import PromptsPage from '@/pages/prompts';
import { chatSearch } from '@/lib/search-params';

export const Route = createFileRoute('/prompts')({
  component: PromptsPage,
  validateSearch: chatSearch,
});
