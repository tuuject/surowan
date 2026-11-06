import { createFileRoute } from '@tanstack/react-router';
import { chatSearch } from '@/lib/search-params';
import DictionaryPage from '@/pages/dictionary';

export const Route = createFileRoute('/dictionary')({
  component: DictionaryPage,
  validateSearch: chatSearch,
});
