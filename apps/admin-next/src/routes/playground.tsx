import { createFileRoute } from '@tanstack/react-router';
import PlaygroundPage from '@/pages/playground';

/** The selected room lives in the URL, so a reload or a deep link restores it. */
export const Route = createFileRoute('/playground')({
  component: PlaygroundPage,
  validateSearch: (search: Record<string, unknown>): { room?: string } =>
    typeof search.room === 'string' && /^[1-9][0-9]{0,18}$/.test(search.room) ? { room: search.room } : {},
});
