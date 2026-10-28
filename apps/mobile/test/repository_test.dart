import 'package:flutter_test/flutter_test.dart';
import 'package:price_tracker/sample_repository.dart';
import 'package:price_tracker/tracker_repository.dart';

void main() {
  const alerts = AlertPreferences(email: false, push: true);
  SampleTrackerRepository repository() =>
      SampleTrackerRepository(delay: Duration.zero);

  test(
    'safe integer USD money, free vs unknown, and exact decimal parsing',
    () {
      expect(Money.parse('0').amountMinor, 0);
      expect(Money.parse(' 9.9 ').amountMinor, 990);
      expect(Money(0).formatted, '\$0.00');
      expect(Money(999).formatted, '\$9.99');
      expect(Money(0).currency, 'USD');
      expect(Money.parse('90071992547409.91').amountMinor, 9007199254740991);
      for (final invalid in [
        '',
        '-1',
        '1.001',
        '1e2',
        'NaN',
        'Infinity',
        '1,000',
        '90071992547409.92',
      ]) {
        expect(
          () => Money.parse(invalid),
          throwsFormatException,
          reason: invalid,
        );
      }
      expect(() => Money(-1), throwsArgumentError);
      expect(() => Money(9007199254740992), throwsArgumentError);
    },
  );
  test(
    'local exact preview allowlist rejects unsafe and unsupported URLs',
    () async {
      final repo = repository();
      final product = (await repo.preview(
        'https://store.steampowered.com/app/620/Portal_2/',
      )).product;
      expect(product.steamAppId, '620');
      expect(product.providerGameId, '36');
      expect(product.identity, 'cheapshark:36:1:US:USD');
      for (final url in [
        'http://store.steampowered.com/app/620/',
        'https://store.steampowered.com.evil.test/app/620/',
        'https://store.steampowered.com@evil.test/app/620/',
        'https://user:secret@store.steampowered.com/app/620/',
        'https://store.steampowered.com:444/app/620/',
        'https://store.steampowered.com/bundle/620/',
        'https://store.steampowered.com/sub/620/',
        'https://store.steampowered.com/app/620/extra/path/',
        'https://store.steampowered.com/app/620/?url=https://evil.test',
        'https://store.steampowered.com/app/620/#fragment',
        'https://store.steampowered.com/app/000620/',
        'https://store.steampowered.com/app/999999/',
        'file:///etc/passwd',
        'x' * 2049,
      ]) {
        await expectLater(
          repo.preview(url),
          throwsA(isA<RepositoryException>()),
          reason: url,
        );
      }
    },
  );
  test('local CRUD, search, duplicates, independent preferences and stable history', () async {
    final repo = repository()..reset(empty: true);
    expect(await repo.list(), isEmpty);
    final preview = await repo.preview(
      'https://store.steampowered.com/app/620/',
    );
    final item = await repo.create(
      previewId: preview.id,
      targetPrice: Money(0),
      enabled: false,
      alerts: alerts,
    );
    expect(item.id, isNot(preview.product.id));
    expect((await repo.list(search: 'portal')).single.id, item.id);
    expect(await repo.list(search: 'half'), isEmpty);
    await expectLater(
      repo.create(
        previewId: preview.id,
        targetPrice: Money(100),
        enabled: true,
        alerts: alerts,
      ),
      throwsA(isA<RepositoryException>()),
    );
    final history = await repo.history(item.id);
    final updated = await repo.update(
      item.id,
      targetPrice: Money(2000),
      enabled: true,
      alerts: const AlertPreferences(email: true, push: false),
    );
    expect(updated.targetPrice.amountMinor, 2000);
    expect(updated.alerts.email, true);
    expect(updated.alerts.push, false);
    expect(updated.enabled, true);
    expect(updated.product.price!.amountMinor, 999);
    expect(updated.createdAt, item.createdAt);
    expect(
      (await repo.history(item.id)).map((entry) => entry.price.amountMinor),
      history.map((entry) => entry.price.amountMinor),
    );
    await repo.delete(item.id);
    expect(await repo.list(), isEmpty);
    await expectLater(repo.get(item.id), throwsA(isA<RepositoryException>()));
    await expectLater(
      repo.history(item.id),
      throwsA(isA<RepositoryException>()),
    );
    expect((await repository().list()).length, 2);
  });
  test(
    'preview expiry cannot save an expired or fabricated identity',
    () async {
      var now = DateTime.utc(2026, 10, 28);
      final repo = SampleTrackerRepository(delay: Duration.zero, now: () => now)
        ..reset(empty: true);
      final preview = await repo.preview(
        'https://store.steampowered.com/app/620/',
      );
      now = now.add(const Duration(minutes: 10));
      for (final id in [preview.id, 'forged']) {
        await expectLater(
          repo.create(
            previewId: id,
            targetPrice: Money(0),
            enabled: true,
            alerts: alerts,
          ),
          throwsA(isA<RepositoryException>()),
        );
      }
      expect(await repo.list(), isEmpty);
    },
  );
  test('failed observation retains success; unavailable without observations stays null', () async {
    final repo = repository();
    final original = (await repo.list()).first;
    repo.scenario = SampleScenario.stale;
    final stale = (await repo.get(original.id)).product;
    expect(stale.price!.amountMinor, 999);
    expect(stale.observedAt, original.product.observedAt);
    expect(stale.providerChangedAt, isNull);
    expect(stale.lastError, isNotNull);
    expect(stale.lastAttemptAt, isNotNull);
    repo.scenario = SampleScenario.missingOffer;
    final missing = (await repo.get(original.id)).product;
    expect(missing.price, isNull);
    expect(missing.purchaseUrl, isNull);
    expect(await repo.history(original.id), isEmpty);
    await expectLater(
      repo.preview('https://store.steampowered.com/app/620/'),
      throwsA(isA<RepositoryException>()),
    );
  });
  test(
    'offline mutations preserve records and expiry is a distinct failure',
    () async {
      final repo = repository();
      final item = (await repo.list()).first;
      repo.scenario = SampleScenario.offline;
      await expectLater(
        repo.update(
          item.id,
          targetPrice: Money(0),
          enabled: false,
          alerts: alerts,
        ),
        throwsA(isA<RepositoryException>()),
      );
      await expectLater(
        repo.delete(item.id),
        throwsA(isA<RepositoryException>()),
      );
      repo.scenario = SampleScenario.normal;
      expect((await repo.get(item.id)).targetPrice.amountMinor, 499);
      repo.scenario = SampleScenario.expired;
      await expectLater(
        repo.list(),
        throwsA(
          isA<RepositoryException>().having(
            (error) => error.expired,
            'expired',
            true,
          ),
        ),
      );
    },
  );
  test('purchase links have exact destination and one encoded deal ID', () {
    for (final product in sampleProducts) {
      expect(isSafePurchaseUrl(product.purchaseUrl!), true);
    }
    for (final url in [
      'https://evil.test/redirect?dealID=abc',
      'http://www.cheapshark.com/redirect?dealID=abc',
      'https://user@www.cheapshark.com/redirect?dealID=abc',
      'https://www.cheapshark.com/redirect?dealID=',
      'https://www.cheapshark.com/redirect?dealID=a&dealID=b',
      'https://www.cheapshark.com/redirect?dealID=a&next=evil',
      'https://www.cheapshark.com/redirect?dealID=a#fragment',
    ]) {
      expect(isSafePurchaseUrl(Uri.parse(url)), false, reason: url);
    }
  });
}
