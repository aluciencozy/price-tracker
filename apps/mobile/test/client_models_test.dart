import 'package:flutter_test/flutter_test.dart';
import 'package:price_tracker/client/models.dart';

import 'client_fixtures.dart';

void main() {
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
