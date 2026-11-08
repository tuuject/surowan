import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { MessageDetailView } from '@/pages/message-detail';

export const Route = createFileRoute('/messages_/$messageId')({
  component: MessageDetailRoute,
});

function MessageDetailRoute(): ReactElement {
  const { messageId } = Route.useParams();
  return <MessageDetailView id={messageId} />;
}
