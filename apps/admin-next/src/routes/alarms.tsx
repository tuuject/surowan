import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import AlarmsPage from '@/pages/alarms';

export const Route = createFileRoute('/alarms')({
  component: AlarmsPage,
  validateSearch: listQuerySearch,
});
