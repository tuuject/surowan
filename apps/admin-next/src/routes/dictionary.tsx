import { createFileRoute } from '@tanstack/react-router';
import DictionaryPage from '@/pages/dictionary';
import { chatSearch } from '@/lib/search-params';

export const Route = createFileRoute('/dictionary')({
  component: DictionaryPage,
  validateSearch: chatSearch,
});
