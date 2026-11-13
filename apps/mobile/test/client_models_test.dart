import 'package:flutter_test/flutter_test.dart';
import 'package:price_tracker/client/models.dart';

import 'client_fixtures.dart';

Json syntheticBrotatoProductJson() {
  final json = productJson();
  final identity = Map<String, dynamic>.from(json['identity'] as Map);
  identity['providerGameId'] = '90001';
  json['identity'] = identity;
  json['steamAppId'] = '1942280';
  json['canonicalSteamUrl'] = 'https://store.steampowered.com/app/1942280/';
  json['title'] = 'Brotato';
  // providerGameId 90001 is deliberately synthetic, not a verified mapping.
  return json;
}

void main() {
  test('purchase URLs match strict one-decode form serialization', () {
    const prefix = 'https://www.cheapshark.com/redirect?dealID=';
    for (final entry in {
      'a/b': 'a%2Fb',
      'a%2Fb': 'a%2Fb',
      'space id': 'space+id',
      'space%20and%2Bplus': 'space+and%2Bplus',
      'plus+id': 'plus%2Bid',
      'percent%25': 'percent%25',
      'a%252Fb': 'a%252Fb',
      '*~': '*%7E',
      "!'()": '%21%27%28%29',
    }.entries) {
      final json = productJson()
        ..['dealId'] = entry.key
        ..['purchaseUrl'] = '$prefix${entry.value}';
      expect(Product.fromJson(json).purchaseUrl, '$prefix${entry.value}');
    }
    for (final id in ['bad%', 'bad%2', 'bad%GG', '%FF']) {
      expect(
        () => Product.fromJson(productJson()..['dealId'] = id),
        throwsFormatException,
      );
    }
    for (final suffix in ['other', 'a%252Fb', 'a%2Fb&extra=1', 'a%2Fb#x']) {
      expect(
        () => Product.fromJson(
          productJson()
            ..['dealId'] = 'a%2Fb'
            ..['purchaseUrl'] = '$prefix$suffix',
        ),
        throwsFormatException,
      );
    }
  });
  test('deal ID bounds count 256 Unicode codepoints', () {
    for (final char in ['x', '一', '🎮']) {
      final id = char * 256;
      final json = productJson()
        ..['dealId'] = id
        ..['purchaseUrl'] = canonicalPurchaseUrl(id);
      expect(Product.fromJson(json).dealId, id);
      expect(
        () => Product.fromJson(json..['dealId'] = char * 257),
        throwsFormatException,
      );
    }
  });
  test('contract string limits count Unicode characters, not UTF16 units', () {
    expect(User.fromJson(userJson()..['name'] = '🎮' * 100).name, '🎮' * 100);
    expect(
      () => User.fromJson(userJson()..['name'] = '🎮' * 101),
      throwsFormatException,
    );
  });
  test('parses contract user, complete session, tracker and history', () {
    expect(Session.fromJson(sessionJson()).toJson(), sessionJson());
    final tracker = TrackedItem.fromJson(trackerJson());
    expect(tracker.targetPrice.amountMinor, 0);
    expect(tracker.product.identity.providerGameId, '36');
    expect(tracker.product.steamAppId, '620');
    expect(tracker.product.lastError!.occurredAt, now);
    expect(tracker.product.observedAt, DateTime.parse(observed));
    expect(
      History.fromJson(historyJson()).page.items.single.price.amountMinor,
      999,
    );
  });
  test('accepts current exact-app and known legacy attribution literals only', () {
    const legacy =
        'Prices supplied by CheapShark; Steam US/USD base-game offer, excluding taxes and checkout adjustments.';
    const current =
        'Prices supplied by CheapShark; exact Steam app US/USD offer, excluding taxes and checkout adjustments.';
    // productJson() retains the old literal used by historical contract examples.
    final legacyProduct = productJson();
    expect(Product.fromJson(legacyProduct).source.attribution, legacy);
    final currentProduct = productJson();
    currentProduct['source'] = {
      ...(currentProduct['source'] as Map<String, dynamic>),
      'attribution': current,
    };
    expect(Product.fromJson(currentProduct).source.attribution, current);

    final unknown = productJson();
    unknown['source'] = {
      ...(unknown['source'] as Map<String, dynamic>),
      'attribution': 'Prices supplied by CheapShark; Steam game offer.',
    };
    expect(() => Product.fromJson(unknown), throwsFormatException);
  });
  test('accepts a synthetic dynamic Brotato app ID without conflating provider identity', () {
    final product = Product.fromJson(syntheticBrotatoProductJson());
    expect(product.steamAppId, '1942280');
    expect(
      product.canonicalSteamUrl,
      'https://store.steampowered.com/app/1942280/',
    );
    expect(product.title, 'Brotato');
    expect(product.identity.providerGameId, '90001');
    expect(product.identity.providerGameId, isNot(product.steamAppId));

    final mismatched = syntheticBrotatoProductJson()
      ..['canonicalSteamUrl'] = 'https://store.steampowered.com/app/620/';
    expect(() => Product.fromJson(mismatched), throwsFormatException);
  });
  test(
    'zero is free, null is unavailable and failed checks preserve last success',
    () {
      expect(
        Product.fromJson(productJson()..['currentPrice'] = moneyJson(0))
            .currentPrice!
            .amountMinor,
        0,
      );
      expect(Product.fromJson(unavailableJson()).currentPrice, isNull);
      final stale = Product.fromJson(productJson());
      expect(stale.currentPrice!.amountMinor, 999);
      expect(stale.lastError!.code, 'PROVIDER_UNAVAILABLE');
      expect(stale.providerChangedAt, isNull);
    },
  );
  test('money rejects coercion, fractions, negative, unsafe and non-USD', () {
    for (final amount in [-1, 1.5, 0.0, '0', null, true, 9007199254740992]) {
      expect(
        () => Money.fromJson({'amountMinor': amount, 'currency': 'USD'}),
        throwsFormatException,
      );
    }
    expect(
      () => Money.fromJson({'amountMinor': 0, 'currency': 'EUR'}),
      throwsFormatException,
    );
  });
  test(
    'rejects unverified, incomplete, wrongly typed and oversized sessions',
    () {
      for (final json in [
        sessionJson()..['user'] = (userJson()..['emailVerified'] = false),
        sessionJson()..remove('sessionId'),
        sessionJson()..['expiresIn'] = 3600,
        sessionJson()..['expiresIn'] = '604800',
        sessionJson()..['tokenType'] = 'cookie',
        sessionJson()..['accessToken'] = 'token\r\nheader',
        sessionJson()..['accessToken'] = 'x' * 8193,
        sessionJson()..['extra'] = true,
      ]) {
        expect(() => Session.fromJson(json), throwsFormatException);
      }
    },
  );
  test(
    'strict products reject missing nullable keys, identities and unsafe links',
    () {
      for (final json in [
        productJson()..remove('currentPrice'),
        productJson()..['steamAppId'] = 620,
        productJson()
          ..['identity'] = {
            'provider': 'cheapshark',
            'providerGameId': '36',
            'storeId': '2',
            'market': 'US',
            'currency': 'USD',
          },
        productJson()
          ..['canonicalSteamUrl'] = 'https://store.steampowered.com/app/220/',
        productJson()
          ..['purchaseUrl'] = 'https://evil.example/redirect?dealID=x',
        productJson()
          ..['purchaseUrl'] =
              'https://www.cheapshark.com/redirect?dealID=wrong',
        productJson()..['imageUrl'] = 'javascript:alert(1)',
        unavailableJson()..['currentPrice'] = moneyJson(0),
        productJson()..['freshness'] = 'fresh',
        productJson()..['currentPrice'] = null,
      ]) {
        expect(() => Product.fromJson(json), throwsFormatException);
      }
      expect(
        () => TrackedItem.fromJson(trackerJson()..['enabled'] = 'true'),
        throwsFormatException,
      );
    },
  );
  test(
    'UTC timestamps reject normalized impossible dates and missing timezone',
    () {
      for (final time in [
        '2026-02-30T12:00:00Z',
        '2026-10-28T24:00:00Z',
        '2026-10-28',
        '2026-10-28T12:00:00',
        '2026-10-28T12:00:00+00:00',
      ]) {
        expect(
          () => User.fromJson(userJson()..['createdAt'] = time),
          throwsFormatException,
        );
      }
    },
  );
  test('history and pages preserve bounds, cursor and required retention', () {
    final history = History.fromJson(historyJson());
    expect(history.page.nextCursor, isNull);
    expect(history.retainedFrom, DateTime.utc(2026, 10));
    for (final json in [
      historyJson()..['retainedFrom'] = null,
      historyJson()..['window'] = {'from': time, 'to': time},
      historyJson()..['page'] = {'limit': 0, 'nextCursor': null},
    ]) {
      expect(() => History.fromJson(json), throwsFormatException);
    }
  });
}
