import { createFileRoute } from '@tanstack/react-router';
import { chatSearch } from '@/lib/search-params';
import MessagesPage from '@/pages/messages';

export const Route = createFileRoute('/messages')({
  component: MessagesPage,
  validateSearch: chatSearch,
});
