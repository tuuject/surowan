import { createFileRoute } from '@tanstack/react-router';
import HarnessPage from '@/pages/harness';

export const Route = createFileRoute('/harness')({ component: HarnessPage });
