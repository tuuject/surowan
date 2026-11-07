import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import ApiKeysPage from '@/pages/api-keys';

export const Route = createFileRoute('/api-keys')({ component: ApiKeysPage, validateSearch: listQuerySearch });
