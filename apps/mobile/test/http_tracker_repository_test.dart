import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:price_tracker/client/http_tracker_repository.dart';
import 'package:price_tracker/client/mobile_api.dart';
import 'package:price_tracker/client/models.dart' as wire;
import 'package:price_tracker/tracker_repository.dart';

import 'client_fixtures.dart';

void main() {
  HttpTrackerRepository repository(
    Future<http.Response> Function(http.Request) handle,
  ) {
    final client = MockClient(handle);
    addTearDown(client.close);
    final api = MobileApi(
      client: client,
      baseUrl: 'https://api.example.test',
      now: () => now,
    )..setSession(wire.Session.fromJson(sessionJson()));
    final repository = HttpTrackerRepository(api);
    addTearDown(repository.dispose);
    return repository;
  }

  http.Response response(Object value, [int status = 200]) =>
      http.Response(jsonEncode(value), status);

  test(
    'adapter maps nullable/free/stale metadata without sample substitution',
    () async {
      var unavailable = false;
      final repo = repository(
        (_) async => response(
          trackerJson()
            ..['product'] = (unavailable
                ? unavailableJson()
                : (productJson()..['currentPrice'] = moneyJson(0))),
        ),
      );
      final free = await repo.get('tracker_example');
      expect(free.product.price!.amountMinor, 0);
      expect(free.product.lastError, 'Try later.');
      expect(free.product.staleAt, DateTime.parse('2026-10-27T16:34:42.829Z'));
      expect(free.product.nextCheckAt, isNotNull);
      expect(free.alerts.email, isTrue);
      expect(free.alerts.push, isFalse);
      unavailable = true;
      final missing = await repo.get('tracker_example');
      expect(missing.product.price, isNull);
      expect(missing.product.purchaseUrl, isNull);
    },
  );

  test(
    'private search pagination keeps filter/cursor and merges pages',
    () async {
      final repo = repository((request) async {
        expect(request.url.queryParameters['q'], 'Portal');
        if (request.url.queryParameters['cursor'] == null) {
          return response(
            pageJson()..['page'] = {'limit': 20, 'nextCursor': 'opaque'},
          );
        }
        expect(request.url.queryParameters['cursor'], 'opaque');
        return response(
          pageJson()..['items'] = [trackerJson()..['id'] = 'tracker_two'],
        );
      });
      expect((await repo.list(search: ' Portal ')).length, 1);
      expect(repo.hasMore, isTrue);
      expect((await repo.loadMore()).map((t) => t.id), [
        'tracker_example',
        'tracker_two',
      ]);
      expect(repo.hasMore, isFalse);
    },
  );

  test(
    'history exhausts pages using fixed returned window, no invented points',
    () async {
      var calls = 0;
      final repo = repository((request) async {
        calls++;
        if (calls == 1) {
          return response(
            historyJson()
              ..['page'] = {'limit': 20, 'nextCursor': 'history_next'},
          );
        }
        expect(request.url.queryParameters, {
          'limit': '20',
          'cursor': 'history_next',
          'from': '2026-10-01T00:00:00.000Z',
          'to': time,
        });
        return response(historyJson()..['items'] = []);
      });
      final history = await repo.history('tracker_example');
      expect(calls, 2);
      expect(history.length, 1);
      expect(history.single.observedAt, DateTime.parse(observed));
      expect(repo.historyMetadataFor('tracker_example')!.to, now);
    },
  );

  test(
    'uncertain create retries retain original UUID and exact zero/prefs JSON',
    () async {
      String? key;
      var calls = 0;
      final repo = repository((request) async {
        final current = request.headers['Idempotency-Key'];
        key ??= current;
        expect(current, key);
        expect(RegExp(r'^[a-f0-9-]{36}$').hasMatch(current!), isTrue);
        expect(jsonDecode(request.body), {
          'previewId': 'preview_example',
          'targetPrice': moneyJson(0),
          'enabled': false,
          'alerts': {'email': false, 'push': true},
        });
        calls++;
        if (calls == 1) throw http.ClientException('offline');
        return response(trackerJson(), 201);
      });
      Future<Tracker> create() => repo.create(
        previewId: 'preview_example',
        targetPrice: Money(0),
        enabled: false,
        alerts: const AlertPreferences(email: false, push: true),
      );
      await expectLater(create(), throwsA(isA<RepositoryException>()));
      await create();
      expect(calls, 2);
    },
  );

  test('error mapping preserves owned duplicate and field messages', () async {
    final repo = repository(
      (_) async => response(
        errorJson('DUPLICATE_TRACKED_ITEM', resource: 'tracker_example'),
        409,
      ),
    );
    await expectLater(
      repo.get('tracker_example'),
      throwsA(
        isA<RepositoryException>()
            .having((e) => e.code, 'code', 'DUPLICATE_TRACKED_ITEM')
            .having((e) => e.resourceId, 'owned tracker', 'tracker_example'),
      ),
    );
  });

  test(
    'Retry-After prevents extra network calls, including a new search',
    () async {
      var calls = 0;
      final repo = repository((_) async {
        calls++;
        return response(errorJson('RATE_LIMITED', retry: 60), 429);
      });
      await expectLater(repo.list(), throwsA(isA<RepositoryException>()));
      await expectLater(
        repo.list(search: 'different'),
        throwsA(
          isA<RepositoryException>().having(
            (e) => e.retryAfterSeconds,
            'retry',
            greaterThan(0),
          ),
        ),
      );
      expect(calls, 1);
    },
  );

  test(
    'disposed repository cannot publish late data or restore private caches',
    () async {
      final pending = Completer<http.Response>();
      final repo = repository((_) => pending.future);
      final load = repo.list();
      repo.dispose();
      pending.complete(response(pageJson()));
      await expectLater(
        load,
        throwsA(
          isA<RepositoryException>().having((e) => e.expired, 'expired', true),
        ),
      );
      expect(repo.hasMore, isFalse);
      expect(repo.historyMetadata, isEmpty);
    },
  );
}
