import { createFileRoute } from '@tanstack/react-router';
import WarningsPage from '@/pages/warnings';

export const Route = createFileRoute('/warnings')({
  component: WarningsPage,
});
