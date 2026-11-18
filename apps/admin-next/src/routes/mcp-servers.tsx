import { createFileRoute } from '@tanstack/react-router';
import { listQuerySearch } from '@/lib/list-query';
import McpServersPage from '@/pages/mcp-servers';

export const Route = createFileRoute('/mcp-servers')({
  component: McpServersPage,
  validateSearch: listQuerySearch,
});
