import { createFileRoute } from '@tanstack/react-router';
import TelegramPage from '@/pages/telegram';

export const Route = createFileRoute('/telegram')({
  component: TelegramPage,
});
