import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import StickersPage from '@/pages/stickers';

export const Route = createFileRoute('/stickers')({
  component: StickersPage,
  validateSearch: listQuerySearch,
});
