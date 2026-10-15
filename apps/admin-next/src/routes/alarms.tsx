import { createFileRoute } from '@tanstack/react-router';
import AlarmsPage from '@/pages/alarms';
import { chatSearch } from '@/lib/search-params';

export const Route = createFileRoute('/alarms')({
  component: AlarmsPage,
  validateSearch: chatSearch,
});
