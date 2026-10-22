import { renderConversation } from './conversation.ts';
import { openDatabase } from './database.ts';
import { renderInvocation } from './invocation.ts';
import { parseOptions } from './options.ts';
import { runPrompt } from './prompt.ts';
import { runSearch } from './search.ts';

export async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const database = openDatabase(options.database);
  try {
    if (options.command === 'invocation') {
      console.log(renderInvocation(database, Number(options.target), options.json));
      return;
    }
    if (options.command === 'conversation') {
      console.log(renderConversation(database, Number(options.target), options.limit, options.json));
      return;
    }
    if (options.command === 'prompt') {
      console.log(await runPrompt(database, Number(options.target), options.out));
      return;
    }
    console.log(runSearch(database, options.text ?? '', options.limit, options.since, options.json));
  } finally {
    database.close();
  }
}
