import { createFileRoute } from '@tanstack/react-router';
import ImageAssetsPage from '@/pages/image-assets';

export const Route = createFileRoute('/image-assets')({
  component: ImageAssetsPage,
});
