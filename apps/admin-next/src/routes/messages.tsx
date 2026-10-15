import { createFileRoute } from '@tanstack/react-router';
import MessagesPage from '@/pages/messages';
import { chatSearch } from '@/lib/search-params';

export const Route = createFileRoute('/messages')({
  component: MessagesPage,
  validateSearch: chatSearch,
});
