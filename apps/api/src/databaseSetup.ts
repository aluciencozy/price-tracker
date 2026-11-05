import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { ProductModel } from './models/product.js';
import { createDatabaseIndexes } from './models/index.js';

/** Metadata only. The measured October 26 price is intentionally not seeded. */
export const initialCatalog = [
  { steamAppId: '620', providerGameId: '36', title: 'Portal 2' },
  { steamAppId: '220', providerGameId: '59', title: 'Half-Life 2' },
] as const;

export async function seedCatalog(): Promise<void> {
  for (const game of initialCatalog) {
    const identity = { provider: 'cheapshark' as const, providerGameId: game.providerGameId, storeId: '1' as const, market: 'US' as const, currency: 'USD' as const };
    await ProductModel.updateOne(identity, { $setOnInsert: {
      ...identity, steamAppId: game.steamAppId, title: game.title,
      canonicalSteamUrl: `https://store.steampowered.com/app/${game.steamAppId}/`,
    } }, { upsert: true, runValidators: true }).exec();
  }
}

/** Prove rollback rather than assuming that a MongoDB-compatible host supports it. */
export async function verifyTransactions(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database is not connected.');
  try {
    await db.createCollection('infrastructureprobes');
  } catch (error) {
    if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 48) throw error;
  }
  const collection = db.collection('infrastructureprobes');
  const probeId = randomUUID();
  const aborted = new Error('Expected probe rollback.');
  const session = await mongoose.startSession();
  try {
    try {
      await session.withTransaction(async () => {
        await collection.insertOne({ probeId }, { session });
        throw aborted;
      });
    } catch (error) {
      if (error !== aborted) throw error;
    }
    if (await collection.findOne({ probeId })) throw new Error('Rollback did not remove probe.');
    await session.withTransaction(async () => {
      await collection.insertOne({ probeId }, { session });
    });
    if (!await collection.findOne({ probeId })) throw new Error('Commit did not persist probe.');
  } finally {
    await session.endSession();
    await collection.deleteOne({ probeId });
  }
}

/** Never use implicit admin/test databases for operational commands. */
export function validateSetupUri(uri: string | undefined): string {
  if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri)) throw new Error('MONGODB_URI is required.');
  // SRV and ordinary single-host URIs parse with URL; multi-host replica-set
  // connection strings have the same path grammar but aren't WHATWG URLs.
  const path = uri.slice(uri.indexOf('://') + 3).split('?')[0]?.split('/').slice(1).join('/');
  if (!path || !/^[a-zA-Z0-9_-]+$/.test(path) || ['admin', 'config', 'local', 'test'].includes(path)) {
    throw new Error('Use an explicit application database in MONGODB_URI.');
  }
  return uri;
}

export async function runDatabaseSetup(command: string | undefined): Promise<void> {
  if (!['indexes', 'seed', 'verify'].includes(command ?? '')) throw new Error('Expected indexes, seed or verify.');
  const uri = validateSetupUri(process.env.MONGODB_URI);
  try {
    await mongoose.connect(uri, { autoIndex: false, serverSelectionTimeoutMS: 5000 });
    if (command === 'verify') {
      await mongoose.connection.db!.command({ ping: 1 });
      await verifyTransactions();
    } else {
      await createDatabaseIndexes();
      if (command === 'seed') await seedCatalog();
    }
  } finally {
    await mongoose.disconnect();
  }
}
