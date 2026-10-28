import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:price_tracker/client/mobile_api.dart';
import 'package:price_tracker/client/session_controller.dart';
import 'package:price_tracker/client/session_store.dart';

import 'client_fixtures.dart';

class MemorySessionStore implements SessionStore {
  String? value;
  bool failRead = false, failWrite = false, failClear = false;
  Completer<void>? clearing;
  @override
  Future<String?> read() async {
    if (failRead) throw StateError('fixture');
    return value;
  }

  @override
  Future<void> write(String input) async {
    if (failWrite) throw StateError('fixture');
    value = input;
  }

  @override
  Future<void> clear() async {
    if (failClear) throw StateError('fixture');
    if (clearing != null) await clearing!.future;
    value = null;
  }
}

Matcher failure(String code) =>
    isA<ApiFailure>().having((e) => e.code, 'code', code);

void main() {
  late MemorySessionStore store;
  late SessionController controller;
  late MobileApi api;
  var clock = now;
  void setup(Future<http.Response> Function(http.Request) handle) {
    clock = now;
    store = MemorySessionStore();
    final client = MockClient(handle);
    api = MobileApi(
      client: client,
      baseUrl: 'https://api.example.test',
      now: () => clock,
    );
    controller = SessionController(api: api, store: store, now: () => clock);
    addTearDown(controller.dispose);
    addTearDown(client.close);
  }

  Future<http.Response> loginResponse(http.Request _) async =>
      http.Response(jsonEncode(sessionJson()), 200);

  test('login persists only complete validated session and publishes verified user', () async {
    setup(loginResponse);
    await controller.login('a@example.test', 'fixture');
    expect(jsonDecode(store.value!), sessionJson());
    expect(controller.user!.id, 'user_example');
    expect(controller.sessionId, 'session_example');
  });

  test('invalid/unverified login is never written', () async {
    setup(
      (_) async => http.Response(
        jsonEncode(
          sessionJson()..['user'] = (userJson()..['emailVerified'] = false),
        ),
        200,
      ),
    );
    await expectLater(
      controller.login('a@example.test', 'fixture'),
      throwsA(failure('INVALID_RESPONSE')),
    );
    expect(store.value, isNull);
    expect(controller.user, isNull);
  });

  test(
    'startup reads secure storage then /me before allowing private state',
    () async {
      setup((request) async {
        expect(request.url.path, '/api/auth/mobile/me');
        expect(
          request.headers['Authorization'],
          'Bearer illustrative-not-a-signed-jwt',
        );
        expect(controller.user, isNull);
        return http.Response(jsonEncode(userJson()..['name'] = 'Updated'), 200);
      });
      store.value = jsonEncode(sessionJson());
      await controller.restore();
      expect(controller.user!.name, 'Updated');
      expect(store.value, isNotNull);
    },
  );

  test('missing, corrupt and expired storage do not call API', () async {
    setup((_) async => throw StateError('unexpected HTTP'));
    await controller.restore();
    for (final saved in [
      'not json',
      jsonEncode(sessionJson()..['expiresAt'] = time),
    ]) {
      store.value = saved;
      await expectLater(controller.restore(), throwsA(isA<ApiFailure>()));
      expect(store.value, isNull);
      expect(controller.user, isNull);
    }
  });

  test('startup offline retains credentials for retry, not signed-in/sample success', () async {
    var offline = true;
    setup((_) async {
      if (offline) throw http.ClientException('offline');
      return http.Response(jsonEncode(userJson()), 200);
    });
    store.value = jsonEncode(sessionJson());
    await expectLater(controller.restore(), throwsA(failure('OFFLINE')));
    expect(store.value, isNotNull);
    expect(controller.user, isNull);
    // An accidental unauthenticated private request must not delete retryable storage.
    await expectLater(api.list(), throwsA(failure('AUTH_REQUIRED')));
    expect(store.value, isNotNull);
    offline = false;
    await controller.restore();
    expect(controller.user!.id, 'user_example');
  });

  test('normal private network failure does not silently log out', () async {
    setup((request) async {
      if (request.url.path.endsWith('/login')) return loginResponse(request);
      throw http.ClientException('offline');
    });
    await controller.login('a@example.test', 'fixture');
    await expectLater(api.list(), throwsA(failure('OFFLINE')));
    expect(controller.user, isNotNull);
    expect(store.value, isNotNull);
  });

  test(
    '401 revocation clears private user, session ID, and secure record',
    () async {
      var revoked = false;
      setup(
        (request) async => revoked
            ? http.Response(jsonEncode(errorJson('SESSION_REVOKED')), 401)
            : loginResponse(request),
      );
      await controller.login('a@example.test', 'fixture');
      var notifications = 0;
      controller.addListener(() {
        if (controller.user == null) notifications++;
      });
      revoked = true;
      await expectLater(api.list(), throwsA(failure('SESSION_REVOKED')));
      expect(store.value, isNull);
      expect(controller.user, isNull);
      expect(controller.sessionId, isNull);
      expect(notifications, 1);
    },
  );

  test(
    'local expiry clears without a request or refresh endpoint call',
    () async {
      var calls = 0;
      setup((request) async {
        calls++;
        return loginResponse(request);
      });
      await controller.login('a@example.test', 'fixture');
      clock = now.add(const Duration(days: 7));
      await expectLater(api.list(), throwsA(failure('SESSION_EXPIRED')));
      expect(calls, 1);
      expect(store.value, isNull);
      expect(controller.user, isNull);
    },
  );

  testWidgets('idle session expires and clears private state on its deadline', (
    tester,
  ) async {
    setup(loginResponse);
    await controller.login('a@example.test', 'fixture');
    clock = now.add(const Duration(days: 7));
    await tester.pump(const Duration(days: 7));
    expect(controller.user, isNull);
    expect(store.value, isNull);
    expect(controller.expiryFailure!.code, 'SESSION_EXPIRED');
  });

  test(
    'logout clears immediately and attempts bodyless bearer revocation',
    () async {
      final pending = Completer<http.Response>();
      setup((request) async {
        if (request.url.path.endsWith('/logout')) {
          expect(request.body, isEmpty);
          expect(
            request.headers['Authorization'],
            'Bearer illustrative-not-a-signed-jwt',
          );
          return pending.future;
        }
        return loginResponse(request);
      });
      await controller.login('a@example.test', 'fixture');
      final logout = controller.logout();
      expect(controller.user, isNull);
      expect(store.value, isNull);
      pending.complete(http.Response('', 204));
      await logout;
    },
  );

  test(
    'offline logout clears local state but reports failed server revocation',
    () async {
      setup((request) async {
        if (request.url.path.endsWith('/logout')) {
          throw http.ClientException('offline');
        }
        return loginResponse(request);
      });
      await controller.login('a@example.test', 'fixture');
      await expectLater(controller.logout(), throwsA(failure('OFFLINE')));
      expect(store.value, isNull);
      expect(controller.user, isNull);
    },
  );

  test('secure read/write/delete failures never pretend success', () async {
    setup(
      (request) async => request.url.path.endsWith('/logout')
          ? http.Response('', 204)
          : loginResponse(request),
    );
    store.failRead = true;
    await expectLater(controller.restore(), throwsA(failure('STORAGE')));
    store.failRead = false;
    store.failWrite = true;
    await expectLater(
      controller.login('a@example.test', 'fixture'),
      throwsA(failure('STORAGE')),
    );
    expect(controller.user, isNull);
    store.failWrite = false;
    await controller.login('a@example.test', 'fixture');
    store.failClear = true;
    await expectLater(controller.logout(), throwsA(failure('STORAGE')));
    expect(controller.user, isNull);
    expect(store.value, isNotNull);
  });

  test(
    'overlapping account actions rejected instead of stale account writes',
    () async {
      final pending = Completer<http.Response>();
      setup((_) => pending.future);
      final login = controller.login('a@example.test', 'fixture');
      await expectLater(controller.logout(), throwsA(failure('BUSY')));
      pending.complete(http.Response(jsonEncode(sessionJson()), 200));
      await login;
    },
  );

  test('reentrant login waits for revoked-account secure deletion', () async {
    var revoked = false;
    setup(
      (request) async => revoked && !request.url.path.endsWith('/login')
          ? http.Response(jsonEncode(errorJson('SESSION_REVOKED')), 401)
          : loginResponse(request),
    );
    await controller.login('a@example.test', 'fixture');
    store.clearing = Completer<void>();
    Future<void>? login;
    controller.addListener(() {
      if (controller.user == null) {
        login ??= controller.login('a@example.test', 'fixture');
      }
    });
    revoked = true;
    final old = expectLater(api.list(), throwsA(failure('SESSION_REVOKED')));
    await Future<void>.delayed(Duration.zero);
    expect(controller.user, isNull);
    expect(login, isNotNull);
    store.clearing!.complete();
    await old;
    await login!;
    expect(controller.user, isNotNull);
    expect(store.value, isNotNull);
  });

  test(
    'offline startup credentials can still be revoked on explicit logout',
    () async {
      var revocations = 0;
      setup((request) async {
        if (request.url.path.endsWith('/me')) {
          throw http.ClientException('offline');
        }
        expect(request.url.path, '/api/auth/mobile/logout');
        expect(
          request.headers['Authorization'],
          'Bearer illustrative-not-a-signed-jwt',
        );
        revocations++;
        return http.Response('', 204);
      });
      store.value = jsonEncode(sessionJson());
      await expectLater(controller.restore(), throwsA(failure('OFFLINE')));
      await expectLater(
        controller.login('different@example.test', 'fixture'),
        throwsA(failure('ALREADY_SIGNED_IN')),
      );
      await controller.logout();
      expect(revocations, 1);
      expect(store.value, isNull);
    },
  );

  test(
    'repeated restore cannot turn an active account into an offline logout',
    () async {
      var calls = 0;
      setup((request) async {
        calls++;
        return loginResponse(request);
      });
      await controller.login('a@example.test', 'fixture');
      await controller.restore();
      expect(calls, 1);
      expect(controller.user, isNotNull);
    },
  );

  testWidgets(
    'idle expiry reports a failed secure deletion without keeping private data',
    (tester) async {
      setup(loginResponse);
      await controller.login('a@example.test', 'fixture');
      store.failClear = true;
      clock = now.add(const Duration(days: 7));
      await tester.pump(const Duration(days: 7));
      expect(controller.user, isNull);
      expect(store.value, isNotNull);
      expect(controller.expiryFailure!.code, 'STORAGE');
    },
  );

  test('a login finishing after disposal cannot republish a user or transport token', () async {
    final pending = Completer<http.Response>();
    final client = MockClient((_) => pending.future);
    addTearDown(client.close);
    final api = MobileApi(
      client: client,
      baseUrl: 'https://api.example.test',
      now: () => now,
    );
    final controller = SessionController(
      api: api,
      store: MemorySessionStore(),
      now: () => now,
    );
    var notifications = 0;
    controller.addListener(() {
      notifications++;
    });
    final login = controller.login('a@example.test', 'fixture');
    controller.dispose();
    pending.complete(http.Response(jsonEncode(sessionJson()), 200));
    await login;
    expect(notifications, 0);
    expect(controller.user, isNull);
    await expectLater(api.me(), throwsA(failure('AUTH_REQUIRED')));
  });
}
