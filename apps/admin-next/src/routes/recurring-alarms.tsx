import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import RecurringAlarmsPage from '@/pages/recurring-alarms';

export const Route = createFileRoute('/recurring-alarms')({
  component: RecurringAlarmsPage,
  validateSearch: listQuerySearch,
});
