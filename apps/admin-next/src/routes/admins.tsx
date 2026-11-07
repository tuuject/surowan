import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import AdminsPage from '@/pages/admins';

export const Route = createFileRoute('/admins')({
  component: AdminsPage,
  validateSearch: listQuerySearch,
});
