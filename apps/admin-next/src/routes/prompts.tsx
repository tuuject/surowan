import { createFileRoute } from '@tanstack/react-router';
import { chatSearch } from '@/lib/search-params';
import PromptsPage from '@/pages/prompts';

export const Route = createFileRoute('/prompts')({
  component: PromptsPage,
  validateSearch: chatSearch,
});
