import { createFileRoute } from '@tanstack/react-router';
import DecisionGatePage from '@/pages/decision-gate';

export const Route = createFileRoute('/decision-gate')({ component: DecisionGatePage });
