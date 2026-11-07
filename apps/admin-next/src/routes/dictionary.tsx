import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import DictionaryPage from '@/pages/dictionary';

export const Route = createFileRoute('/dictionary')({
  component: DictionaryPage,
  validateSearch: listQuerySearch,
});
