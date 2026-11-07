import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import ChatsPage from '@/pages/chats';

export const Route = createFileRoute('/chats')({
  component: ChatsPage,
  validateSearch: listQuerySearch,
});
