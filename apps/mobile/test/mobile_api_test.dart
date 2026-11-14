import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:price_tracker/client/mobile_api.dart';
import 'package:price_tracker/client/models.dart';

import 'client_fixtures.dart';

Matcher failure(String code) =>
    isA<ApiFailure>().having((error) => error.code, 'code', code);
http.Response jsonResponse(
  Object json, [
  int status = 200,
  Map<String, String>? headers,
]) => http.Response(jsonEncode(json), status, headers: headers ?? const {});

void main() {
  MobileApi apiFor(
    Future<http.Response> Function(http.Request) handle, {
    bool authenticated = true,
    Duration timeout = const Duration(seconds: 10),
  }) {
    final client = MockClient(handle);
    addTearDown(client.close);
    final api = MobileApi(
      client: client,
      baseUrl: 'https://api.example.test',
      now: () => now,
      timeout: timeout,
    );
    if (authenticated) api.setSession(Session.fromJson(sessionJson()));
    return api;
  }

  test(
    'login sends exact JSON without cookies, CSRF, bearer or redirects',
    () async {
      final api = apiFor((request) async {
        expect(request.method, 'POST');
        expect(
          request.url.toString(),
          'https://api.example.test/api/auth/mobile/login',
        );
        expect(jsonDecode(request.body), {
          'email': 'player@example.com',
          'password': ' not trimmed ',
        });
        expect(request.headers['Content-Type'], startsWith('application/json'));
        expect(request.headers['Authorization'], isNull);
        expect(request.headers['Cookie'], isNull);
        expect(request.headers['X-CSRF-Token'], isNull);
        expect(request.followRedirects, isFalse);
        return jsonResponse(sessionJson());
      });
      final session = await api.login('player@example.com', ' not trimmed ');
      expect(session.user.name, isNull);
      expect(session.expiresAt, now.add(const Duration(days: 7)));
    },
  );

  test(
    'public email operations use generic accepted responses and exact bodies',
    () async {
      final seen = <String>[];
      final bodies = <Object?>[];
      final api = apiFor((request) async {
        expect(request.headers['Authorization'], isNull);
        seen.add('${request.method} ${request.url.path}');
        bodies.add(jsonDecode(request.body));
        return jsonResponse({
          'message': 'If eligible, you will receive an email with next steps.',
        }, 202);
      });
      await api.register(
        email: 'a@example.test',
        password: 'fixture-password',
        name: 'Player',
      );
      await api.register(email: 'a@example.test', password: 'fixture-password');
      await api.resendVerification('a@example.test');
      await api.forgotPassword('a@example.test');
      expect(seen, [
        'POST /api/auth/mobile/register',
        'POST /api/auth/mobile/register',
        'POST /api/auth/mobile/resend-verification',
        'POST /api/auth/mobile/forgot-password',
      ]);
      expect(bodies, [
        {
          'email': 'a@example.test',
          'password': 'fixture-password',
          'name': 'Player',
        },
        {'email': 'a@example.test', 'password': 'fixture-password'},
        {'email': 'a@example.test'},
        {'email': 'a@example.test'},
      ]);
    },
  );

  test(
    'preview only calls fixed API origin, never submitted URL/provider',
    () async {
      final api = apiFor((request) async {
        expect(
          request.url.toString(),
          'https://api.example.test/api/product-previews',
        );
        expect(
          request.headers['Authorization'],
          'Bearer illustrative-not-a-signed-jwt',
        );
        expect(jsonDecode(request.body), {
          'url': 'https://store.steampowered.com/app/620/',
        });
        return jsonResponse({
          'id': 'preview_example',
          'expiresAt': time,
          'product': productJson(),
        }, 201);
      });
      expect(
        (await api.preview('https://store.steampowered.com/app/620/'))
            .product
            .identity
            .providerGameId,
        '36',
      );
    },
  );

  test(
    'preview sends a dynamic Brotato URL only to the configured API',
    () async {
      const url = 'https://store.steampowered.com/app/1942280/';
      final product = productJson();
      product['identity'] = {
        ...(product['identity'] as Map<String, dynamic>),
        'providerGameId': '90001',
      };
      product['steamAppId'] = '1942280';
      product['canonicalSteamUrl'] = url;
      product['title'] = 'Brotato';
      // This is an offline client fixture; provider game ID 90001 is synthetic.
      final api = apiFor((request) async {
        expect(
          request.url.toString(),
          'https://api.example.test/api/product-previews',
        );
        expect(jsonDecode(request.body), {'url': url});
        expect(request.url.host, 'api.example.test');
        return jsonResponse({
          'id': 'preview_brotato_fixture',
          'expiresAt': time,
          'product': product,
        }, 201);
      });

      final result = await api.preview(url);

      expect(result.product.steamAppId, '1942280');
      expect(result.product.title, 'Brotato');
      expect(result.product.identity.providerGameId, '90001');
      expect(result.product.currentPrice!.amountMinor, 999);
    },
  );

  test(
    'create whitelists fields and reuses caller supplied idempotency key',
    () async {
      var calls = 0;
      final api = apiFor((request) async {
        calls++;
        expect(request.method, 'POST');
        expect(request.url.path, '/api/tracked-items');
        expect(request.headers['Idempotency-Key'], uuid);
        expect(jsonDecode(request.body), {
          'previewId': 'preview_example',
          'targetPrice': moneyJson(0),
          'enabled': false,
          'alerts': {'email': false, 'push': true},
        });
        return jsonResponse(trackerJson(), 201);
      });
      Future<TrackedItem> create() => api.create(
        previewId: 'preview_example',
        targetPrice: Money(0),
        enabled: false,
        alerts: const Alerts(email: false, push: true),
        idempotencyKey: uuid,
      );
      await create();
      await create();
      expect(calls, 2);
      expect(
        () => api.create(
          previewId: 'preview_example',
          targetPrice: Money(0),
          enabled: false,
          alerts: const Alerts(email: false, push: true),
          idempotencyKey: 'bad',
        ),
        throwsArgumentError,
      );
    },
  );

  test(
    'list uses q/cursor/limit; get and PATCH send only editable fields',
    () async {
      final api = apiFor((request) async {
        if (request.url.path == '/api/tracked-items') {
          expect(request.url.queryParameters, {
            'q': 'Portal & 2',
            'cursor': 'opaque+/=',
            'limit': '20',
          });
          return jsonResponse(pageJson());
        }
        expect(request.url.path, '/api/tracked-items/tracker_example');
        if (request.method == 'PATCH') {
          expect(jsonDecode(request.body), {
            'targetPrice': moneyJson(0),
            'enabled': false,
            'alerts': {'email': true, 'push': false},
          });
        } else {
          expect(request.method, 'GET');
          expect(request.body, isEmpty);
        }
        return jsonResponse(trackerJson());
      });
      expect(
        (await api.list(
          search: 'Portal & 2',
          cursor: 'opaque+/=',
        )).items.single.id,
        'tracker_example',
      );
      await api.get('tracker_example');
      await api.update(
        'tracker_example',
        targetPrice: Money(0),
        enabled: false,
        alerts: const Alerts(email: true, push: false),
      );
      expect(() => api.update('tracker_example'), throwsArgumentError);
      expect(() => api.get('../auth/mobile/me'), throwsArgumentError);
      expect(() => api.list(limit: 101), throwsArgumentError);
    },
  );

  test('history sends repeated normalized window and retains successful observations', () async {
    final from = DateTime.utc(2026, 10);
    final api = apiFor((request) async {
      expect(request.url.path, '/api/tracked-items/tracker_example/history');
      expect(request.url.queryParameters, {
        'from': from.toIso8601String(),
        'to': time,
        'limit': '20',
        'cursor': 'next',
      });
      return jsonResponse(historyJson());
    });
    final history = await api.history(
      'tracker_example',
      from: from,
      to: now,
      cursor: 'next',
    );
    expect(history.page.items.single.observedAt, DateTime.parse(observed));
    expect(history.product.currentPrice!.amountMinor, 999);
    expect(history.retainedFrom, from);
    expect(
      () => api.history('tracker_example', from: now, to: now),
      throwsArgumentError,
    );
  });

  test(
    'refresh uses only the fixed owned API routes and native bearer session',
    () async {
      final paths = <String>[];
      final api = apiFor((request) async {
        paths.add('${request.method} ${request.url.path}');
        expect(request.url.host, 'api.example.test');
        expect(
          request.headers['Authorization'],
          'Bearer illustrative-not-a-signed-jwt',
        );
        expect(request.headers['Cookie'], isNull);
        expect(request.headers['X-CSRF-Token'], isNull);
        expect(request.followRedirects, isFalse);
        if (request.method == 'POST') {
          expect(request.body, '{}');
          expect(
            request.url.path,
            '/api/tracked-items/tracker_example/refresh',
          );
          return jsonResponse(refreshJson('queued'), 202, {
            'location': '/api/tracked-item-refreshes/refresh_example',
            'retry-after': '5',
          });
        }
        expect(request.method, 'GET');
        expect(request.body, isEmpty);
        return jsonResponse(refreshJson('cached'), 200, {'retry-after': '12'});
      });
      final queued = await api.startTrackedItemRefresh('tracker_example');
      final poll = await api.getTrackedItemRefresh(
        queued.request.id,
        'tracker_example',
      );
      expect(queued.request.status, 'queued');
      expect(poll.request.status, 'cached');
      expect(poll.pollAfterSeconds, 12);
      expect(paths, [
        'POST /api/tracked-items/tracker_example/refresh',
        'GET /api/tracked-item-refreshes/refresh_example',
      ]);
    },
  );

  test('refresh polling rejects another tracker or request identity', () async {
    final api = apiFor((request) async {
      return jsonResponse(refreshJson('queued', id: 'some_other_request'));
    });
    await expectLater(
      api.getTrackedItemRefresh('refresh_example', 'tracker_example'),
      throwsA(failure('INVALID_RESPONSE')),
    );
  });

  test('accepts any schema-valid status in the 202 response', () async {
    for (final status in [
      'queued',
      'running',
      'cached',
      'refreshed',
      'deferred',
      'failed',
    ]) {
      final api = apiFor((request) async {
        final result = refreshJson(status);
        return jsonResponse(result, 202, {
          'location': '/api/tracked-item-refreshes/${result['id']}',
          'retry-after': '5',
        });
      });
      await expectLater(
        api.startTrackedItemRefresh('tracker_example'),
        completion(
          isA<RefreshPoll>().having(
            (poll) => poll.request.status,
            'status',
            status,
          ),
        ),
      );
    }
  });

  test(
    'refresh acceptance requires its matching private Location and wait',
    () async {
      final api = apiFor((request) async {
        return jsonResponse(refreshJson('queued'), 202, {
          'location': '/api/tracked-item-refreshes/another_request',
          'retry-after': '5',
        });
      });
      await expectLater(
        api.startTrackedItemRefresh('tracker_example'),
        throwsA(failure('INVALID_RESPONSE')),
      );
    },
  );

  test(
    'refresh polling headers accept only numeric waits of five seconds or more',
    () async {
      for (final retryAfter in <String?>[null, '4', '+5', '5 seconds']) {
        final api = apiFor((request) async {
          return jsonResponse(refreshJson('queued'), 202, {
            'location': '/api/tracked-item-refreshes/refresh_example',
            'retry-after': ?retryAfter,
          });
        });
        await expectLater(
          api.startTrackedItemRefresh('tracker_example'),
          throwsA(failure('INVALID_RESPONSE')),
        );
      }
    },
  );

  test('bodyless DELETE, me and logout; empty 204 needs no JSON', () async {
    final paths = <String>[];
    final api = apiFor((request) async {
      paths.add('${request.method} ${request.url.path}');
      expect(request.body, isEmpty);
      expect(request.headers['Content-Type'], isNull);
      expect(
        request.headers['Authorization'],
        'Bearer illustrative-not-a-signed-jwt',
      );
      return request.url.path.endsWith('/me')
          ? jsonResponse(userJson())
          : http.Response('', 204);
    });
    await api.me();
    await api.delete('tracker_example');
    await api.logout();
    expect(paths, [
      'GET /api/auth/mobile/me',
      'DELETE /api/tracked-items/tracker_example',
      'POST /api/auth/mobile/logout',
    ]);
  });

  test('validation, duplicate and throttling errors preserve safe structured details', () async {
    for (final status in [409, 422, 429]) {
      final error = errorJson(
        status == 409 ? 'DUPLICATE_TRACKED_ITEM' : 'VALIDATION_ERROR',
        retry: 30,
        resource: 'tracker_example',
      );
      (error['error'] as Json)['fields'] = [
        {
          'path': '/targetPrice/amountMinor',
          'code': 'out_of_range',
          'message': 'Use integer cents.',
        },
      ];
      final api = apiFor(
        (_) async => jsonResponse(error, status, {'retry-after': '60'}),
      );
      await expectLater(
        api.list(),
        throwsA(
          isA<ApiFailure>()
              .having((e) => e.status, 'status', status)
              .having(
                (e) => e.fields.single.path,
                'field',
                '/targetPrice/amountMinor',
              )
              .having((e) => e.requestId, 'request', 'request_example')
              .having((e) => e.retryAfterSeconds, 'larger wait', 60)
              .having((e) => e.resourceId, 'resource', 'tracker_example'),
        ),
      );
    }
  });

  test('HTML, wrong shape/types, redirects, invalid UTF8 and oversized bodies fail safely', () async {
    for (final response in [
      http.Response('<secret>proxy</secret>', 502),
      http.Response('redirect', 302),
      http.Response('{}', 200),
      http.Response('not json', 200),
      http.Response.bytes([255], 200),
      http.Response('x' * (1024 * 1024 + 1), 200),
      jsonResponse({...pageJson(), 'extra': true}),
    ]) {
      final api = apiFor((_) async => response);
      await expectLater(api.list(), throwsA(failure('INVALID_RESPONSE')));
    }
  });

  test('foreign/mismatched response identity is not accepted', () async {
    final api = apiFor((_) async => jsonResponse(trackerJson()));
    await expectLater(
      api.get('different'),
      throwsA(failure('INVALID_RESPONSE')),
    );
  });

  test('offline and timeout make no retry or sample fallback', () async {
    var calls = 0;
    final offline = apiFor((_) async {
      calls++;
      throw http.ClientException('secret');
    });
    await expectLater(offline.list(), throwsA(failure('OFFLINE')));
    expect(calls, 1);
    final pending = Completer<http.Response>();
    final timeout = apiFor(
      (_) => pending.future,
      timeout: const Duration(milliseconds: 1),
    );
    await expectLater(timeout.list(), throwsA(failure('TIMEOUT')));
    pending.complete(jsonResponse(pageJson()));
  });

  test(
    'total deadline includes response body and triggers transport abort',
    () async {
      final body = StreamController<List<int>>();
      late Future<void> abort;
      final client = MockClient.streaming((request, _) async {
        abort = (request as http.Abortable).abortTrigger!;
        return http.StreamedResponse(body.stream, 200);
      });
      addTearDown(client.close);
      final api = MobileApi(
        client: client,
        baseUrl: 'https://api.example.test',
        now: () => now,
        timeout: const Duration(milliseconds: 1),
      );
      api.setSession(Session.fromJson(sessionJson()));
      await expectLater(api.list(), throwsA(failure('TIMEOUT')));
      await abort;
      await body.close();
    },
  );

  test('401 clears even when error body is malformed', () async {
    final api = apiFor((_) async => http.Response('expired', 401));
    var cleared = 0;
    api.onUnauthorized = () async {
      cleared++;
    };
    await expectLater(api.list(), throwsA(isA<ApiFailure>()));
    expect(cleared, 1);
  });

  test(
    'logout blocks new requests and discards old in-flight private responses',
    () async {
      final pending = Completer<http.Response>();
      final revocation = Completer<http.Response>();
      final api = apiFor(
        (request) => request.url.path.endsWith('/logout')
            ? revocation.future
            : pending.future,
      );
      final old = api.list();
      final logout = api.logout();
      await expectLater(
        api.get('tracker_example'),
        throwsA(failure('AUTH_REQUIRED')),
      );
      pending.complete(jsonResponse(pageJson()));
      await expectLater(old, throwsA(failure('SESSION_CHANGED')));
      revocation.complete(http.Response('', 204));
      await logout;
    },
  );

  test(
    'local expiry rejects a successful response arriving too late',
    () async {
      var clock = now;
      final pending = Completer<http.Response>();
      final client = MockClient((_) => pending.future);
      addTearDown(client.close);
      final api = MobileApi(
        client: client,
        baseUrl: 'https://api.example.test',
        now: () => clock,
      );
      api.setSession(Session.fromJson(sessionJson()));
      final request = api.list();
      clock = now.add(const Duration(days: 7));
      pending.complete(jsonResponse(pageJson()));
      await expectLater(request, throwsA(failure('SESSION_EXPIRED')));
    },
  );

  test(
    'expired and unverified login responses cannot become a session',
    () async {
      for (final json in [
        sessionJson()..['expiresAt'] = time,
        sessionJson()..['user'] = (userJson()..['emailVerified'] = false),
      ]) {
        final api = apiFor(
          (_) async => jsonResponse(json),
          authenticated: false,
        );
        await expectLater(
          api.login('a@example.test', 'fixture'),
          throwsA(failure('INVALID_RESPONSE')),
        );
      }
    },
  );

  test(
    'unknown error codes and malformed error fields cannot leak raw bodies',
    () async {
      for (final error in [
        errorJson('SECRET_BODY'),
        errorJson('VALIDATION_ERROR')
          ..['error'] = {'code': 'VALIDATION_ERROR', 'message': 'SECRET_BODY'},
      ]) {
        final api = apiFor((_) async => jsonResponse(error, 500));
        await expectLater(api.list(), throwsA(failure('INVALID_RESPONSE')));
      }
      expect(
        const ApiFailure('OFFLINE', 'secret').toString(),
        isNot(contains('secret')),
      );
    },
  );

  test('origin validation follows HealthApi syntax with secure credential transport', () {
    final client = MockClient((_) async => http.Response('', 204));
    addTearDown(client.close);
    for (final origin in [
      'file:///etc/passwd',
      'https://user:pass@example.test',
      'https://example.test/api',
      'https://example.test?x=1',
      'https://example.test#x',
      'http://example.test',
      'http://192.168.1.2:4000',
    ]) {
      expect(
        () => MobileApi(client: client, baseUrl: origin),
        throwsArgumentError,
      );
    }
    for (final origin in [
      'https://example.test/',
      'http://10.0.2.2:4000',
      'http://127.0.0.1:4000',
    ]) {
      expect(() => MobileApi(client: client, baseUrl: origin), returnsNormally);
    }
  });
}
