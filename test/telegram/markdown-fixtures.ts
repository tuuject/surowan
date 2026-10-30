/** Entities as Telegram reports them: offsets of the first occurrence of `part`. */
export function entity(text: string, part: string, type: string, extra: Record<string, unknown> = {}) {
  const offset = text.indexOf(part);
  if (offset < 0) {
    throw new Error(`"${part}" is not in the text`);
  }
  return { type, offset, length: part.length, ...extra };
}

/** A rich message with photos, an image Document, other media and a spoiler run. */
export const RICH_MEDIA = {
  blocks: [
    { type: 'paragraph', text: 'Look:' },
    {
      type: 'collage',
      blocks: [
        {
          type: 'photo',
          photo: [
            { file_id: 'photo-1-small', file_unique_id: 'photo-1-small-unique', width: 90, height: 60 },
            { file_id: 'photo-1-large', file_unique_id: 'photo-1-unique', width: 1280, height: 853, file_size: 1000 },
          ],
        },
        {
          type: 'photo',
          has_spoiler: true,
          photo: [{ file_id: 'photo-2', file_unique_id: 'photo-2-unique', width: 800, height: 600 }],
        },
      ],
      caption: { text: 'Two shots', credit: 'Alice' },
    },
    {
      type: 'video',
      video: { file_id: 'video', file_unique_id: 'video-unique', width: 640, height: 360, duration: 3 },
      caption: { text: 'A clip' },
    },
    {
      type: 'document',
      document: {
        file_id: 'chart',
        file_unique_id: 'chart-unique',
        file_name: 'chart.png',
        mime_type: 'image/png',
        file_size: 2048,
      },
    },
    {
      type: 'document',
      document: {
        file_id: 'report',
        file_unique_id: 'report-unique',
        file_name: 'report.pdf',
        mime_type: 'application/pdf',
        file_size: 4096,
      },
    },
    {
      type: 'audio',
      audio: { file_id: 'audio', file_unique_id: 'audio-unique', duration: 10, performer: 'Band', title: 'Song' },
    },
    { type: 'paragraph', text: ['Secret: ', { type: 'spoiler', text: 'it was the butler' }] },
  ],
};
