import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import MessagesPage from '@/pages/messages';

export const Route = createFileRoute('/messages')({
  component: MessagesPage,
  validateSearch: listQuerySearch,
});
