import 'package:price_tracker/client/models.dart';

// Offline identities/quote shape from contract 47dc976; no live-price claim.
final now = DateTime.utc(2026, 10, 28, 12);
const time = '2026-10-28T12:00:00.000Z';
const observed = '2026-10-26T16:34:42.829Z';
const uuid = '624031ba-726a-454d-8308-909b1b0a0031';
Json moneyJson([int amount = 999]) => {
  'amountMinor': amount,
  'currency': 'USD',
};
Json userJson() => {
  'id': 'user_example',
  'email': 'player@example.com',
  'name': null,
  'emailVerified': true,
  'role': 'user',
  'createdAt': time,
};
Json sessionJson() => {
  'accessToken': 'illustrative-not-a-signed-jwt',
  'tokenType': 'Bearer',
  'expiresIn': 604800,
  'expiresAt': '2026-11-04T12:00:00.000Z',
  'sessionId': 'session_example',
  'user': userJson(),
};
Json productJson() => {
  'id': 'product_1',
  'identity': {
    'provider': 'cheapshark',
    'providerGameId': '36',
    'storeId': '1',
    'market': 'US',
    'currency': 'USD',
  },
  'steamAppId': '620',
  'canonicalSteamUrl': 'https://store.steampowered.com/app/620/',
  'title': 'Portal 2',
  'storeName': 'Steam',
  'imageUrl': null,
  'source': {
    'name': 'CheapShark',
    'url': 'https://www.cheapshark.com/',
    'attribution': 'Prices supplied by CheapShark; Steam US/USD base-game offer, excluding taxes and checkout adjustments.',
  },
  'currentPrice': moneyJson(),
  'retailPrice': moneyJson(),
  'dealId': 'fixture+deal/=',
  'purchaseUrl':
      'https://www.cheapshark.com/redirect?dealID=fixture%2Bdeal%2F%3D',
  'observedAt': observed,
  'providerChangedAt': null,
  'freshness': 'stale',
  'staleAt': '2026-10-27T16:34:42.829Z',
  'lastAttemptAt': time,
  'nextCheckAt': '2026-10-29T12:00:00.000Z',
  'lastError': {
    'code': 'PROVIDER_UNAVAILABLE',
    'message': 'Try later.',
    'occurredAt': time,
    'retryAt': null,
  },
};
Json unavailableJson() => productJson()
  ..['currentPrice'] = null
  ..['retailPrice'] = null
  ..['dealId'] = null
  ..['purchaseUrl'] = null
  ..['observedAt'] = null
  ..['providerChangedAt'] = null
  ..['freshness'] = 'unavailable'
  ..['staleAt'] = null;
Json trackerJson() => {
  'id': 'tracker_example',
  'product': productJson(),
  'targetPrice': moneyJson(0),
  'enabled': true,
  'alerts': {'email': true, 'push': false},
  'createdAt': time,
  'updatedAt': time,
};
Json pageJson() => {
  'items': [trackerJson()],
  'page': {'limit': 20, 'nextCursor': null},
};
Json historyJson() => {
  'trackedItemId': 'tracker_example',
  'product': productJson(),
  'window': {'from': '2026-10-01T00:00:00.000Z', 'to': time},
  'retainedFrom': '2026-10-01T00:00:00.000Z',
  'items': [
    {
      'id': 'observation_example',
      'price': moneyJson(),
      'observedAt': observed,
      'providerChangedAt': null,
    },
  ],
  'page': {'limit': 20, 'nextCursor': null},
};
Json errorJson(String code, {int? retry, String? resource}) => {
  'error': {
    'code': code,
    'message': 'Fixture error.',
    'fields': [],
    'requestId': 'request_example',
    'retryAfterSeconds': retry,
    'resourceId': resource,
  },
};
