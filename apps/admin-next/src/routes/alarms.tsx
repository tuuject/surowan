import { createFileRoute } from '@tanstack/react-router';
import { chatSearch } from '@/lib/search-params';
import AlarmsPage from '@/pages/alarms';

export const Route = createFileRoute('/alarms')({
  component: AlarmsPage,
  validateSearch: chatSearch,
});
