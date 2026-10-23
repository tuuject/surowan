import { expect, test } from 'vitest';
import { createLottieCommand } from '../src/capabilities/media/media-image.ts';

test('builds an executable Lottie command for the host platform', () => {
  const command = createLottieCommand(['input.tgs', 'output.png']);
  expect(command.slice(-2)).toEqual(['input.tgs', 'output.png']);
  if (process.platform === 'win32') {
    expect(command.slice(0, 2)).toEqual(['python', '-c']);
  } else {
    expect(command[0]).toBe('lottie_convert.py');
  }
});
