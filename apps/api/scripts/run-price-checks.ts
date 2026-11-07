import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { connectDatabase, disconnectDatabase } from '../src/database.js';
import { createDatabaseIndexes } from '../src/models/index.js';
import { runPriceChecks } from '../src/priceChecks.js';
import type { PriceCheckMode } from '../src/models/priceCheck.js';

function argumentsFrom(argv: string[]): { runId: string; mode: PriceCheckMode; maxProducts?: number } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const match = /^--(run-id|mode|max-products)=(.*)$/.exec(argument);
    if (match) values.set(match[1]!, match[2]!);
    else if (/^--(run-id|mode|max-products)$/.test(argument)) {
      const key = argument.slice(2);
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}.`);
      values.set(key, value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  const runId = values.get('run-id');
  if (!runId || !/^[A-Za-z0-9_-]{8,64}$/.test(runId)) {
    throw new Error('Pass a stable --run-id of 8-64 letters, digits, _ or - to allow safe replay.');
  }
  const mode = values.get('mode') ?? 'cli';
  if (!['scheduled', 'admin', 'cli'].includes(mode)) throw new Error('Mode must be scheduled, admin or cli.');
  const maxText = values.get('max-products');
  const maxProducts = maxText === undefined ? undefined : Number(maxText);
  if (maxProducts !== undefined && (!Number.isInteger(maxProducts) || maxProducts < 1 || maxProducts > 100)) {
    throw new Error('--max-products must be an integer from 1 to 100.');
  }
  return { runId, mode: mode as PriceCheckMode, ...(maxProducts === undefined ? {} : { maxProducts }) };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let options: ReturnType<typeof argumentsFrom>;
  try {
    options = argumentsFrom(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid command line.');
    console.error('Usage: npm run check:prices -- --run-id <stable-id> [--mode cli|scheduled|admin] [--max-products 1-100]');
    return 2;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI must be configured for an explicit price-check run.');
    return 2;
  }
  try {
    const databasePath = decodeURIComponent(new URL(uri).pathname.replace(/^\//, ''));
    if (databasePath === 'price_tracker27051') {
      console.error('Refusing to run against the protected local demo database.');
      return 2;
    }
  } catch {
    console.error('MONGODB_URI is invalid.');
    return 2;
  }

  try {
    await connectDatabase(uri);
    await createDatabaseIndexes();
    const summary = await runPriceChecks(options);
    console.info(JSON.stringify(summary));
    return summary.status === 'complete' ? 0 : 1;
  } catch {
    console.error('Price check did not complete. Retry with the same --run-id; details are stored in MongoDB.');
    return 1;
  } finally {
    await disconnectDatabase();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
