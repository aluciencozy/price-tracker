import 'dotenv/config';
import { disconnectDatabase, connectDatabase } from '../src/database.js';
import { loadConfig } from '../src/config.js';
import { lookupSteamOffer } from '../src/cheapshark.js';

const config = loadConfig();

if (!config.MONGODB_URI) {
  console.error(
    'Set MONGODB_URI in apps/api/.env. The adapter uses MongoDB for its shared request budget.',
  );
  process.exitCode = 1;
} else {
  try {
    await connectDatabase(config.MONGODB_URI);

    // Portal 2 is one of the two base games proved in issue #3.
    const offer = await lookupSteamOffer(
      'https://store.steampowered.com/app/620/',
    );

    console.log(
      JSON.stringify(
        {
          result: 'live adapter lookup succeeded',
          fetchedAt: offer.observedAt,
          title: offer.title,
          steamAppId: offer.steamAppId,
          providerGameId: offer.identity.providerGameId,
          storeId: offer.identity.storeId,
          market: offer.identity.market,
          currency: offer.currentPrice.currency,
          currentPriceMinor: offer.currentPrice.amountMinor,
          canonicalSteamUrl: offer.canonicalSteamUrl,
          purchaseUrl: offer.purchaseUrl,
          source: offer.source,
          providerChangedAt: offer.providerChangedAt,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown lookup error.';
    console.error(`Live CheapShark adapter lookup failed: ${message}`);
    process.exitCode = 1;
  } finally {
    try {
      await disconnectDatabase();
    } catch {
      console.error('MongoDB disconnect did not complete cleanly.');
      process.exitCode = 1;
    }
  }
}
