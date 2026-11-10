import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { ContextDetailView } from '@/pages/context-detail';

export const Route = createFileRoute('/contexts_/$conversationId')({
  component: ContextDetailRoute,
});

function ContextDetailRoute(): ReactElement {
  const { conversationId } = Route.useParams();
  return <ContextDetailView id={conversationId} />;
}
