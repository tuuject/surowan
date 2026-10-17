import { createFileRoute } from '@tanstack/react-router';
import PreferencesPage from '@/pages/preferences';

export const Route = createFileRoute('/preferences')({ component: PreferencesPage });
