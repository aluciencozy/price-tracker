import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:price_tracker/app_config.dart';
import 'package:price_tracker/client/session_controller.dart';
import 'package:price_tracker/main.dart';
import 'package:price_tracker/push/events.dart';
import 'package:price_tracker/push/integration.dart';
import 'package:price_tracker/push/registration.dart';
import 'package:price_tracker/push/storage.dart';

import '../client_fixtures.dart';
import '../live_app_test.dart' show freshSession, response, tap, field;
import '../session_controller_test.dart' show MemorySessionStore;
import 'events_test.dart' show payload;

class FakeGateway implements PushPermissionGateway {
  PushPermission result = PushPermission.granted;
  String? currentToken = 'fixture-token-never-display';
  int permissionCalls = 0;
  final requests = <bool>[];
  @override
  Future<PushPermission> permission({required bool request}) async {
    permissionCalls++;
    requests.add(request);
    return result;
  }

  @override
  Future<String?> token() async => currentToken;
}

class ForbiddenPushStorage implements PushStorage {
  int calls = 0;
  @override
  Future<String> installationId() async {
    calls++;
    throw StateError('unexpected storage');
  }

  @override
  Future<bool> claim({
    required String sessionId,
    required String eventId,
    required int capacity,
  }) async {
    calls++;
    throw StateError('unexpected storage');
  }

  @override
  Future<void> clear() async {
    calls++;
    throw StateError('unexpected storage');
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late PushEventDispatcher dispatcher;
  late MemorySessionStore sessionStore;
  late List<http.Request> requests;
  SessionController? session;
  PushIntegrationController? integration;
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    dispatcher = PushEventDispatcher();
    sessionStore = MemorySessionStore()..value = jsonEncode(freshSession());
    requests = [];
    session = null;
    integration = null;
  });

  Future<void> start(
    WidgetTester tester, {
    PushPermissionGateway gateway = const UnconfiguredPushGateway(),
    PushStorage? storage,
    Future<http.Response?> Function(http.Request)? handle,
    AppConfig config = const AppConfig.api('https://api.example.test'),
  }) async {
    final client = MockClient((request) async {
      requests.add(request);
      final custom = await handle?.call(request);
      if (custom != null) return custom;
      if (request.url.path.endsWith('/me')) return response(userJson());
      if (request.url.path.endsWith('/logout')) return http.Response('', 204);
      if (request.url.path == '/api/devices' ||
          request.url.path.startsWith('/api/devices/')) {
        if (request.method == 'DELETE') return http.Response('', 204);
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        return response({
          'id': 'device_example',
          'installationId': body['installationId'],
          'sessionId': session!.sessionId,
          'platform': 'android',
          'createdAt': time,
          'updatedAt': time,
        }, request.method == 'POST' ? 201 : 200);
      }
      if (request.url.path.endsWith('/history')) return response(historyJson());
      if (request.url.path == '/api/tracked-items') return response(pageJson());
      return response(trackerJson());
    });
    addTearDown(client.close);
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
    });
    await tester.pumpWidget(
      PriceTrackerApp(
        config: config,
        client: client,
        sessionStore: sessionStore,
        pushGateway: gateway,
        pushStorage: storage,
        pushDispatcher: dispatcher,
        sessionIntegrationBuilder: (context, value, child) {
          session = value;
          return Builder(
            builder: (context) {
              integration = PushIntegrationScope.maybeOf(context);
              return child;
            },
          );
        },
      ),
    );
    await tester.pumpAndSettle();
  }

  List<http.Request> getDeviceRequests() =>
      requests.where((r) => r.url.path.startsWith('/api/devices')).toList();
  Future<void> account(WidgetTester tester) =>
      tap(tester, find.byTooltip('Account and settings'));
  Future<void> retryDevice(WidgetTester tester) =>
      tap(tester, find.text('Check permission / retry device'));

  testWidgets(
    'sample mode never touches push gateway, storage, dispatcher or transport',
    (tester) async {
      final gateway = FakeGateway();
      final storage = ForbiddenPushStorage();
      await start(
        tester,
        config: const AppConfig.sample(),
        gateway: gateway,
        storage: storage,
      );
      await account(tester);
      expect(requests, isEmpty);
      expect(gateway.permissionCalls, 0);
      expect(storage.calls, 0);
      expect(session, isNull);
      expect(
        await dispatcher.foreground(payload()),
        ForegroundPushResult.wrongSession,
      );
      expect(await dispatcher.tap(payload()), PushTapResult.wrongSession);
      await dispatcher.tokenChanged();
      expect(requests, isEmpty);
      expect(storage.calls, 0);
    },
  );

  testWidgets(
    'API default is honestly unconfigured; preferences do not register',
    (tester) async {
      final storage = ForbiddenPushStorage();
      await start(tester, storage: storage);
      await account(tester);
      expect(
        find.textContaining('Unconfigured — no Android push provider'),
        findsOneWidget,
      );
      expect(
        find.textContaining('saved tracker push preference is separate'),
        findsOneWidget,
      );
      expect(find.text('Check permission / retry device'), findsNothing);
      expect(getDeviceRequests(), isEmpty);
      expect(storage.calls, 0);
      expect(
        await const FlutterSecureStorage().read(
          key: SecurePushStorage.installationKey,
        ),
        isNull,
      );
    },
  );

  testWidgets(
    'injected gateway exposes denied, no-token, registered and rotation without token UI',
    (tester) async {
      final gateway = FakeGateway()..result = PushPermission.denied;
      await start(tester, gateway: gateway);
      await account(tester);
      expect(find.textContaining('permission denied'), findsOneWidget);
      expect(getDeviceRequests(), isEmpty);
      gateway.result = PushPermission.granted;
      gateway.currentToken = null;
      await retryDevice(tester);
      expect(find.textContaining('no device token'), findsOneWidget);
      gateway.currentToken = 'fixture-token-never-display';
      await retryDevice(tester);
      expect(
        find.textContaining('Device registered with the API'),
        findsOneWidget,
      );
      expect(find.textContaining('delivery are not verified'), findsOneWidget);
      expect(find.textContaining('fixture-token-never-display'), findsNothing);
      final firstId = (jsonDecode(
        getDeviceRequests().single.body,
      ) as Map)['installationId'];
      gateway.currentToken = 'rotated-token';
      await dispatcher.tokenChanged();
      await tester.pumpAndSettle();
      expect(getDeviceRequests().map((r) => r.method), ['POST', 'PUT']);
      expect(
        (jsonDecode(getDeviceRequests().last.body) as Map)['installationId'],
        firstId,
      );
      expect(gateway.requests, [false, true, true, false]);
    },
  );

  testWidgets(
    'missing device on rotation recovers only on explicit next retry',
    (tester) async {
      final gateway = FakeGateway();
      await start(
        tester,
        gateway: gateway,
        handle: (request) async =>
            request.method == 'PUT' ? http.Response('', 404) : null,
      );
      await account(tester);
      gateway.currentToken = 'rotated';
      await dispatcher.tokenChanged();
      await tester.pumpAndSettle();
      expect(find.textContaining('Device registration failed'), findsOneWidget);
      expect(getDeviceRequests().map((r) => r.method), ['POST', 'PUT']);
      await retryDevice(tester);
      expect(getDeviceRequests().map((r) => r.method), ['POST', 'PUT', 'POST']);
      expect(
        find.textContaining('Device registered with the API'),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'offline registration is explicit, retry recovers without sample fallback',
    (tester) async {
      var offline = true;
      await start(
        tester,
        gateway: FakeGateway(),
        handle: (request) async {
          if (request.url.path == '/api/devices' && offline) {
            throw http.ClientException('secret-token');
          }
          return null;
        },
      );
      await account(tester);
      expect(
        find.textContaining('registration unavailable or offline'),
        findsOneWidget,
      );
      expect(find.textContaining('secret-token'), findsNothing);
      offline = false;
      await retryDevice(tester);
      expect(
        find.textContaining('Device registered with the API'),
        findsOneWidget,
      );
      expect(find.textContaining('removal was not confirmed'), findsOneWidget);
    },
  );

  testWidgets(
    'real secure-store adapter dedupes across app reconstruction without notification claims',
    (tester) async {
      await start(tester);
      expect(
        await dispatcher.foreground(payload()),
        ForegroundPushResult.accepted,
      );
      expect(
        await dispatcher.foreground(payload()),
        ForegroundPushResult.duplicate,
      );
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      dispatcher = PushEventDispatcher();
      await start(tester);
      expect(
        await dispatcher.foreground(payload()),
        ForegroundPushResult.duplicate,
      );
    },
  );

  testWidgets(
    'corrupt alert keys fail closed, show error, and explicit clear recovers',
    (tester) async {
      await const FlutterSecureStorage().write(
        key: SecurePushStorage.eventsKey,
        value: 'corrupt',
      );
      await start(tester);
      expect(
        await dispatcher.foreground(payload()),
        ForegroundPushResult.storageUnavailable,
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('No alert was displayed'), findsOneWidget);
      await account(tester);
      await tap(
        tester,
        find.text('Clear local alert keys (allows old alerts again)'),
      );
      expect(
        await dispatcher.foreground(payload()),
        ForegroundPushResult.accepted,
      );
      expect(
        await dispatcher.foreground(payload()),
        ForegroundPushResult.duplicate,
      );
    },
  );

  testWidgets(
    'tap authorizes through repository GET then opens private detail navigation',
    (tester) async {
      await start(tester);
      final opening = dispatcher.tap(payload());
      await tester.pumpAndSettle();
      expect(await opening, PushTapResult.opened);
      expect(find.text('Game details'), findsOneWidget);
      expect(
        requests
            .where((r) => r.url.path == '/api/tracked-items/tracker_example')
            .length,
        2,
      );
      expect(
        requests
            .where((r) => r.url.path == '/api/tracked-items/tracker_example')
            .every(
              (r) =>
                  r.headers['Authorization'] ==
                  'Bearer illustrative-not-a-signed-jwt',
            ),
        isTrue,
      );
      expect(requests.any((r) => r.url.host.contains('cheapshark')), isFalse);
      await session!.logout();
      await tester.pumpAndSettle();
      expect(find.text('Game details'), findsNothing);
      expect(find.text('Portal 2'), findsNothing);
      expect(await dispatcher.tap(payload()), PushTapResult.wrongSession);
    },
  );

  for (final failure in ['404', 'offline', 'mismatched']) {
    testWidgets('tap $failure remains on current route with safe notice', (
      tester,
    ) async {
      await start(
        tester,
        handle: (request) async {
          if (request.url.path != '/api/tracked-items/tracker_example') {
            return null;
          }
          if (failure == '404') return response(errorJson('NOT_FOUND'), 404);
          if (failure == 'offline') throw http.ClientException('raw-secret');
          return response(
            trackerJson()
              ..['product'] = (productJson()..['id'] = 'other-product'),
          );
        },
      );
      final result = dispatcher.tap(payload());
      await tester.pumpAndSettle();
      expect(await result, switch (failure) {
        '404' => PushTapResult.notFound,
        'offline' => PushTapResult.unavailable,
        _ => PushTapResult.invalid,
      });
      expect(find.text('Game details'), findsNothing);
      expect(find.text('Watchlist'), findsOneWidget);
      expect(integration!.notice, isNotNull);
      expect(find.textContaining('raw-secret'), findsNothing);
    });
  }

  testWidgets('tap 401 expires only the current session and private route', (
    tester,
  ) async {
    await start(
      tester,
      handle: (request) async =>
          request.url.path == '/api/tracked-items/tracker_example'
          ? response(errorJson('SESSION_REVOKED'), 401)
          : null,
    );
    final result = dispatcher.tap(payload());
    await tester.pumpAndSettle();
    expect(await result, PushTapResult.wrongSession);
    expect(session!.user, isNull);
    expect(find.text('Game details'), findsNothing);
    expect(find.widgetWithText(FilledButton, 'Sign in'), findsOneWidget);
  });

  testWidgets(
    'device registration 401 ends the matching session and local push immediately',
    (tester) async {
      await start(
        tester,
        gateway: FakeGateway(),
        handle: (request) async =>
            request.method == 'POST' && request.url.path == '/api/devices'
            ? response(errorJson('SESSION_REVOKED'), 401)
            : null,
      );
      expect(session!.user, isNull);
      expect(session!.sessionId, isNull);
      expect(find.widgetWithText(FilledButton, 'Sign in'), findsOneWidget);
      expect(
        await dispatcher.foreground(payload()),
        ForegroundPushResult.wrongSession,
      );
      expect(await dispatcher.tap(payload()), PushTapResult.wrongSession);
    },
  );

  testWidgets(
    'late device 401 from the old session cannot sign out a newer login',
    (tester) async {
      final pending = Completer<http.Response>();
      var posts = 0;
      await start(
        tester,
        gateway: FakeGateway(),
        handle: (request) async {
          if (request.method == 'POST' && request.url.path == '/api/devices') {
            posts++;
            if (posts == 1) return pending.future;
          }
          if (request.url.path.endsWith('/login')) {
            return response(
              freshSession()
                ..['sessionId'] = 'session_B'
                ..['accessToken'] = 'fixture-token-B'
                ..['user'] = (userJson()..['id'] = 'user_B'),
            );
          }
          return null;
        },
      );
      await session!.logout();
      await tester.pumpAndSettle();
      await tester.enterText(field('Email'), 'new@example.com');
      await tester.enterText(field('Password'), 'fixture-password');
      await tap(tester, find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pumpAndSettle();
      expect(session!.sessionId, 'session_B');
      pending.complete(response(errorJson('SESSION_REVOKED'), 401));
      await tester.pumpAndSettle();
      expect(session!.sessionId, 'session_B');
      expect(session!.user!.id, 'user_B');
      expect(integration!.notice, isNull);
      expect(
        getDeviceRequests().last.headers['Authorization'],
        'Bearer fixture-token-B',
      );
    },
  );

  testWidgets(
    'logout clears event keys and uses captured old bearer for cleanup; late 401 cannot kill new login',
    (tester) async {
      final cleanup = Completer<http.Response>();
      await start(
        tester,
        gateway: FakeGateway(),
        handle: (request) async {
          if (request.method == 'DELETE' &&
              request.url.path.startsWith('/api/devices/')) {
            return cleanup.future;
          }
          if (request.url.path.endsWith('/login')) {
            return response(
              freshSession()
                ..['sessionId'] = 'session_B'
                ..['accessToken'] = 'fixture-token-B'
                ..['user'] = (userJson()..['id'] = 'user_B'),
            );
          }
          return null;
        },
      );
      await dispatcher.foreground(payload());
      await session!.logout();
      await tester.pumpAndSettle();
      expect(
        await const FlutterSecureStorage().read(
          key: SecurePushStorage.eventsKey,
        ),
        isNull,
      );
      expect(
        await dispatcher.foreground(payload()),
        ForegroundPushResult.wrongSession,
      );
      await tester.enterText(field('Email'), 'new@example.com');
      await tester.enterText(field('Password'), 'fixture-password');
      await tap(tester, find.widgetWithText(FilledButton, 'Sign in'));
      final removal = getDeviceRequests().firstWhere(
        (r) => r.method == 'DELETE',
      );
      expect(
        removal.headers['Authorization'],
        'Bearer illustrative-not-a-signed-jwt',
      );
      cleanup.complete(response(errorJson('SESSION_REVOKED'), 401));
      await tester.pumpAndSettle();
      expect(session!.sessionId, 'session_B');
      expect(
        getDeviceRequests().last.headers['Authorization'],
        'Bearer fixture-token-B',
      );
      expect(integration!.notice, isNull);
      expect(await dispatcher.tap(payload()), PushTapResult.wrongSession);
      expect(
        await dispatcher.foreground({
          ...payload(),
          'recipientSessionId': 'session_B',
        }),
        ForegroundPushResult.accepted,
      );
    },
  );

  for (final status in [200, 401, 503]) {
    testWidgets(
      'late tap response $status cannot route or expire newly signed-in account',
      (tester) async {
        final pending = Completer<http.Response>();
        await start(
          tester,
          handle: (request) async {
            if (request.url.path == '/api/tracked-items/tracker_example') {
              return pending.future;
            }
            if (request.url.path.endsWith('/login')) {
              return response(
                freshSession()
                  ..['sessionId'] = 'session_B'
                  ..['user'] = (userJson()..['id'] = 'user_B'),
              );
            }
            return null;
          },
        );
        final opening = dispatcher.tap(payload());
        await tester.pump();
        await session!.logout();
        await tester.pumpAndSettle();
        await tester.enterText(field('Email'), 'new@example.com');
        await tester.enterText(field('Password'), 'fixture-password');
        await tap(tester, find.widgetWithText(FilledButton, 'Sign in'));
        pending.complete(
          status == 200
              ? response(trackerJson())
              : response(
                  errorJson(
                    status == 401 ? 'SESSION_REVOKED' : 'SERVICE_UNAVAILABLE',
                  ),
                  status,
                ),
        );
        await tester.pumpAndSettle();
        expect(await opening, PushTapResult.wrongSession);
        expect(session!.sessionId, 'session_B');
        expect(find.text('Game details'), findsNothing);
        expect(integration!.notice, isNull);
      },
    );
  }
}
