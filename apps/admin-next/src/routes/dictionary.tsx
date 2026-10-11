import { createFileRoute } from '@tanstack/react-router';
import DictionaryPage from '@/pages/dictionary';

export const Route = createFileRoute('/dictionary')({
  component: DictionaryPage,
});
