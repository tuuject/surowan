import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { InvocationDetailView } from '@/pages/invocation-detail';

export const Route = createFileRoute('/invocations_/$invocationId')({
  component: InvocationDetailRoute,
});

function InvocationDetailRoute(): ReactElement {
  const { invocationId } = Route.useParams();
  return <InvocationDetailView id={invocationId} />;
}
