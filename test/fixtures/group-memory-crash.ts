import { writeFileSync } from 'node:fs';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { SleepingService } from '../../src/context/group-memory/sleeping.ts';
import { groupMemoryFixture, seedMessage } from '../group-memory/fixtures.ts';

const marker = process.argv[2];
const exitAttempt = Number(process.argv[3]);
if (marker === undefined || ![1, 2].includes(exitAttempt)) {
  throw new Error('Expected marker path and request attempt');
}
const f = await groupMemoryFixture({ faux: true });
const now = new Date();
seedMessage(f.store, f, {
  telegramMessageId: 101,
  date: new Date(now.getTime() - 86_400_000),
  text: 'an event before process termination',
});
let calls = 0;
const response = () => {
  calls += 1;
  if (calls === exitAttempt) {
    writeFileSync(marker, f.directory);
    process.exit(0);
  }
  return fauxAssistantMessage('invalid JSON');
};
if (f.faux === undefined) {
  throw new Error('Missing Faux provider');
}
f.faux.setResponses([response, response]);
await new SleepingService({
  store: f.store,
  configStore: f.configStore,
  secrets: f.secrets,
  isHostReady: () => true,
}).tick(now);
throw new Error('The request never reached the termination point');
