import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:price_tracker/app_config.dart';
import 'package:price_tracker/main.dart';
import 'package:price_tracker/screens.dart';

import 'client_fixtures.dart';
import 'session_controller_test.dart' show MemorySessionStore;

Map<String, dynamic> freshSession() => sessionJson()
  ..['expiresAt'] = DateTime.now()
      .toUtc()
      .add(const Duration(days: 7))
      .toIso8601String();
http.Response response(Object value, [int status = 200]) =>
    http.Response(jsonEncode(value), status);
Finder field(String label) => find.byWidgetPredicate(
  (widget) => widget is TextField && widget.decoration?.labelText == label,
);
Finder get verticalScroll => find
    .byWidgetPredicate(
      (widget) =>
          widget is Scrollable && widget.axisDirection == AxisDirection.down,
    )
    .last;
Future<void> tap(WidgetTester tester, Finder finder) async {
  if (finder.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      finder,
      250,
      maxScrolls: 30,
      scrollable: verticalScroll,
    );
  }
  await Scrollable.ensureVisible(tester.element(finder), alignment: .5);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  Future<void> start(
    WidgetTester tester,
    Future<http.Response> Function(http.Request) handle, {
    MemorySessionStore? store,
    bool signedIn = false,
    bool waitForSettled = true,
  }) async {
    final client = MockClient(handle);
    addTearDown(client.close);
    final storage = store ?? MemorySessionStore();
    if (signedIn) storage.value = jsonEncode(freshSession());
    await tester.pumpWidget(
      PriceTrackerApp(
        config: const AppConfig.api('https://api.example.test'),
        client: client,
        sessionStore: storage,
      ),
    );
    if (waitForSettled) await tester.pumpAndSettle();
  }

  Future<void> credentials(WidgetTester tester) async {
    await tester.enterText(field('Email'), 'player@example.com');
    await tester.enterText(field('Password'), 'fixture-password');
  }

  final submit = find.widgetWithText(FilledButton, 'Sign in');

  test('source values are explicit and invalid ones fail closed', () {
    expect(AppConfig.fromValues(source: 'sample').source, DataSource.sample);
    expect(
      AppConfig.fromValues(
        source: 'api',
        apiBaseUrl: 'https://api.example.test',
      ).source,
      DataSource.api,
    );
    expect(() => AppConfig.fromValues(source: 'API'), throwsArgumentError);
  });

  testWidgets(
    'sample mode never reads credentials or calls the injected live transport',
    (tester) async {
      final storage = MemorySessionStore()..failRead = true;
      var calls = 0;
      final client = MockClient((_) async {
        calls++;
        throw StateError('unexpected network');
      });
      addTearDown(client.close);
      await tester.pumpWidget(
        PriceTrackerApp(
          config: const AppConfig.sample(),
          client: client,
          sessionStore: storage,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text(sampleNotice), findsOneWidget);
      expect(calls, 0);
      await tap(tester, find.byTooltip('Account and settings'));
      await tap(tester, find.text('Preview account flows'));
      expect(find.text('Account flow preview'), findsOneWidget);
      expect(calls, 0);
    },
  );

  testWidgets(
    'invalid API origin shows configuration error, never sample fallback',
    (tester) async {
      for (final origin in ['http://evil.example', 'https://[']) {
        final storage = MemorySessionStore()..failRead = true;
        var calls = 0;
        final client = MockClient((_) async {
          calls++;
          throw StateError('unexpected network');
        });
        addTearDown(client.close);
        await tester.pumpWidget(
          PriceTrackerApp(
            key: ValueKey(origin),
            config: AppConfig.api(origin),
            client: client,
            sessionStore: storage,
          ),
        );
        await tester.pumpAndSettle();
        expect(find.textContaining('Invalid configuration'), findsOneWidget);
        expect(find.text(sampleNotice), findsNothing);
        expect(tester.takeException(), isNull);
        expect(calls, 0);
      }
    },
  );

  testWidgets(
    'live login guards private screens and logout clears routes/storage',
    (tester) async {
      final storage = MemorySessionStore();
      final paths = <String>[];
      await start(tester, (request) async {
        paths.add(request.url.path);
        if (request.url.path.endsWith('/login')) {
          return response(freshSession());
        }
        if (request.url.path.endsWith('/logout')) return http.Response('', 204);
        return response(pageJson());
      }, store: storage);
      expect(find.text('Watchlist'), findsNothing);
      expect(paths, isEmpty);
      await credentials(tester);
      await tap(tester, submit);
      expect(find.text('Watchlist'), findsOneWidget);
      expect(find.text(sampleNotice), findsNothing);
      expect(storage.value, isNotNull);
      await tap(tester, find.byTooltip('Account and settings'));
      await tap(tester, find.widgetWithText(FilledButton, 'Sign out'));
      expect(find.text('Watchlist'), findsNothing);
      expect(find.text('Portal 2'), findsNothing);
      expect(storage.value, isNull);
      expect(paths, [
        '/api/auth/mobile/login',
        '/api/tracked-items',
        '/api/auth/mobile/logout',
      ]);
    },
  );

  testWidgets(
    'startup offline is retryable retained session, not signed-out/sample success',
    (tester) async {
      var offline = true;
      final storage = MemorySessionStore();
      await start(
        tester,
        (request) async {
          if (request.url.path.endsWith('/me')) {
            if (offline) throw http.ClientException('offline');
            return response(userJson());
          }
          return response(pageJson());
        },
        store: storage,
        signedIn: true,
      );
      expect(find.text('Session unavailable'), findsOneWidget);
      expect(storage.value, isNotNull);
      expect(field('Password'), findsNothing);
      offline = false;
      await tap(tester, find.text('Retry session'));
      expect(find.text('Watchlist'), findsOneWidget);
      expect(find.text('Portal 2'), findsOneWidget);
    },
  );

  testWidgets(
    'unverified login shows resend/browser instructions without private state',
    (tester) async {
      await start(
        tester,
        (_) async => response(errorJson('EMAIL_UNVERIFIED'), 403),
      );
      await credentials(tester);
      await tap(tester, submit);
      expect(
        find.textContaining(
          'Verify your email in the browser before signing in',
        ),
        findsOneWidget,
      );
      expect(find.text('Watchlist'), findsNothing);
      await tap(tester, find.widgetWithText(ChoiceChip, 'Verify email'));
      expect(
        find.textContaining('Explicitly confirm verification there'),
        findsOneWidget,
      );
      expect(field('Password'), findsNothing);
    },
  );

  testWidgets(
    'register/resend/forgot submit real fields; reset remains browser-only',
    (tester) async {
      final bodies = <Object?>[];
      final paths = <String>[];
      await start(tester, (request) async {
        paths.add(request.url.path);
        bodies.add(jsonDecode(request.body));
        return response({
          'message': 'If eligible, you will receive an email with next steps.',
        }, 202);
      });
      await tap(tester, find.widgetWithText(ChoiceChip, 'Register'));
      await tester.enterText(field('Email'), 'player@example.com');
      await tester.enterText(field('Name (optional)'), 'Player');
      await tester.enterText(field('Password'), 'fixture-password');
      await tap(tester, find.widgetWithText(FilledButton, 'Register'));
      expect(bodies.single, {
        'email': 'player@example.com',
        'password': 'fixture-password',
        'name': 'Player',
      });
      for (final mode in ['Resend verification', 'Forgot password']) {
        await tap(tester, find.widgetWithText(ChoiceChip, mode));
        await tester.enterText(field('Email'), 'player@example.com');
        await tap(tester, find.widgetWithText(FilledButton, mode));
      }
      expect(paths, [
        '/api/auth/mobile/register',
        '/api/auth/mobile/resend-verification',
        '/api/auth/mobile/forgot-password',
      ]);
      await tap(tester, find.widgetWithText(ChoiceChip, 'Reset password'));
      expect(
        find.textContaining('Choose a new password there'),
        findsOneWidget,
      );
      expect(paths.length, 3);
    },
  );

  testWidgets('401 on detail removes all private routes and late content', (
    tester,
  ) async {
    await start(tester, (request) async {
      if (request.url.path.endsWith('/me')) return response(userJson());
      if (request.url.path == '/api/tracked-items') return response(pageJson());
      return response(errorJson('SESSION_REVOKED'), 401);
    }, signedIn: true);
    await tap(tester, find.text('Portal 2'));
    expect(find.text('Game details'), findsNothing);
    expect(find.text('Portal 2'), findsNothing);
    expect(submit, findsOneWidget);
    expect(find.textContaining('session ended'), findsOneWidget);
  });

  testWidgets(
    'live history is recorded-only and zero target/preferences save with validation',
    (tester) async {
      Map<String, dynamic>? edited;
      await start(tester, (request) async {
        if (request.url.path.endsWith('/me')) return response(userJson());
        if (request.url.path.endsWith('/history')) {
          return response(historyJson());
        }
        if (request.method == 'PATCH') {
          edited = jsonDecode(request.body) as Map<String, dynamic>;
          return response(trackerJson());
        }
        if (request.url.path == '/api/tracked-items') {
          return response(pageJson());
        }
        return response(trackerJson());
      }, signedIn: true);
      await tap(tester, find.text('Portal 2'));
      await tester.scrollUntilVisible(
        find.text('Recorded price observations'),
        250,
        scrollable: verticalScroll,
      );
      expect(find.text('Recorded price observations'), findsOneWidget);
      expect(find.text('Illustrative sample history'), findsNothing);
      await tap(tester, find.text('Edit target and preferences'));
      await tester.enterText(field('Target price (USD)'), '-1');
      await tap(tester, find.text('Save changes'));
      expect(edited, isNull);
      expect(find.textContaining('Enter a USD amount'), findsOneWidget);
      await tester.scrollUntilVisible(
        field('Target price (USD)'),
        -250,
        scrollable: verticalScroll,
      );
      await tester.enterText(field('Target price (USD)'), '0');
      await tap(tester, find.text('Save changes'));
      expect(edited!['targetPrice'], moneyJson(0));
      expect(edited!['alerts'], {'email': true, 'push': false});
    },
  );

  testWidgets(
    'pending login disables submission; rate limit waits without retry loop',
    (tester) async {
      final pending = Completer<http.Response>();
      var calls = 0;
      await start(tester, (_) {
        calls++;
        return pending.future;
      });
      await credentials(tester);
      await tester.ensureVisible(submit);
      await tester.tap(submit);
      await tester.pump();
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);
      pending.complete(response(errorJson('RATE_LIMITED', retry: 3), 429));
      await tester.pumpAndSettle();
      expect(find.text('Try again in 3 seconds.'), findsOneWidget);
      expect(calls, 1);
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(submit).onPressed, isNotNull);
      expect(calls, 1);
    },
  );

  testWidgets(
    'live add preview/create preserve zero and preferences; delete is confirmed',
    (tester) async {
      var saved = false;
      var deletes = 0;
      Map<String, dynamic>? create;
      await start(tester, (request) async {
        if (request.url.path.endsWith('/me')) return response(userJson());
        if (request.url.path == '/api/product-previews') {
          return response({
            'id': 'preview_example',
            'expiresAt': DateTime.now()
                .toUtc()
                .add(const Duration(minutes: 10))
                .toIso8601String(),
            'product': productJson(),
          }, 201);
        }
        if (request.method == 'POST') {
          create = jsonDecode(request.body) as Map<String, dynamic>;
          saved = true;
          return response(trackerJson(), 201);
        }
        if (request.method == 'DELETE') {
          deletes++;
          saved = false;
          return http.Response('', 204);
        }
        if (request.url.path.endsWith('/history')) {
          return response(historyJson());
        }
        if (request.url.path == '/api/tracked-items') {
          return response(pageJson()..['items'] = saved ? [trackerJson()] : []);
        }
        return response(trackerJson());
      }, signedIn: true);
      await tap(tester, find.text('Add game'));
      await tester.enterText(
        field('Steam game URL'),
        'https://store.steampowered.com/app/620/',
      );
      await tap(tester, find.text('Preview game'));
      await tester.enterText(field('Target price (USD)'), '0');
      await tap(tester, find.text('Email preference'));
      await tap(tester, find.text('Android push preference'));
      await tap(tester, find.text('Save tracker'));
      expect(create!['targetPrice'], moneyJson(0));
      expect(create!['alerts'], {'email': false, 'push': true});
      await tap(tester, find.text('Portal 2'));
      await tap(tester, find.text('Remove tracker'));
      await tap(tester, find.text('Keep tracker'));
      expect(deletes, 0);
      await tap(tester, find.text('Remove tracker'));
      await tap(tester, find.widgetWithText(FilledButton, 'Remove'));
      expect(deletes, 1);
      expect(find.text('Your next game starts here.'), findsOneWidget);
    },
  );

  testWidgets(
    'server field errors and duplicates stay in editor, cancel does not save',
    (tester) async {
      var creates = 0;
      await start(tester, (request) async {
        if (request.url.path.endsWith('/me')) return response(userJson());
        if (request.url.path == '/api/tracked-items' &&
            request.method == 'GET') {
          return response(pageJson());
        }
        if (request.url.path == '/api/product-previews') {
          return response({
            'id': 'preview_example',
            'expiresAt': time,
            'product': productJson(),
          }, 201);
        }
        creates++;
        final error = errorJson(
          creates == 1 ? 'VALIDATION_ERROR' : 'DUPLICATE_TRACKED_ITEM',
          resource: creates == 1 ? null : 'tracker_example',
        );
        (error['error'] as Map<String, dynamic>)['message'] = creates == 1
            ? 'Check the target.'
            : 'This offer is already tracked. Edit the existing tracker.';
        if (creates == 1) {
          (error['error'] as Map<String, dynamic>)['fields'] = [
            {
              'path': '/targetPrice/amountMinor',
              'code': 'out_of_range',
              'message': 'Server target validation.',
            },
          ];
        }
        return response(error, creates == 1 ? 422 : 409);
      }, signedIn: true);
      await tap(tester, find.text('Add game'));
      await tester.enterText(
        field('Steam game URL'),
        'https://store.steampowered.com/app/620/',
      );
      await tap(tester, find.text('Preview game'));
      await tester.enterText(field('Target price (USD)'), '0');
      await tap(tester, find.text('Save tracker'));
      expect(
        find.textContaining(
          '/targetPrice/amountMinor: Server target validation.',
        ),
        findsOneWidget,
      );
      await tap(tester, find.text('Save tracker'));
      expect(find.textContaining('already tracked'), findsOneWidget);
      await tap(tester, find.text('Cancel'));
      expect(find.text('Watchlist'), findsOneWidget);
      expect(creates, 2);
    },
  );

  testWidgets(
    'live load errors never use samples; explicit retry can recover empty list',
    (tester) async {
      var offline = true;
      await start(tester, (request) async {
        if (request.url.path.endsWith('/me')) return response(userJson());
        if (offline) throw http.ClientException('offline');
        return response(pageJson()..['items'] = []);
      }, signedIn: true);
      expect(find.textContaining('Could not reach the API'), findsOneWidget);
      expect(find.text('Portal 2'), findsNothing);
      expect(find.text(sampleNotice), findsNothing);
      offline = false;
      await tap(tester, find.text('Try again'));
      expect(find.text('Your next game starts here.'), findsOneWidget);
    },
  );

  testWidgets(
    'expired startup clears credentials and directs back to sign in',
    (tester) async {
      final store = MemorySessionStore()
        ..value = jsonEncode(
          sessionJson()..['expiresAt'] = '2020-01-01T00:00:00Z',
        );
      await start(
        tester,
        (_) async => throw StateError('expired token must not be sent'),
        store: store,
      );
      expect(store.value, isNull);
      expect(submit, findsOneWidget);
      expect(find.textContaining('Please sign in again'), findsOneWidget);
    },
  );

  testWidgets(
    'local cleanup retry is accessible after server logout succeeds but storage deletion fails',
    (tester) async {
      final store = MemorySessionStore();
      var revocations = 0;
      await start(
        tester,
        (request) async {
          if (request.url.path.endsWith('/me')) return response(userJson());
          if (request.url.path.endsWith('/logout')) {
            revocations++;
            return http.Response('', 204);
          }
          return response(pageJson());
        },
        store: store,
        signedIn: true,
      );
      await tap(tester, find.byTooltip('Account and settings'));
      store.failClear = true;
      await tap(tester, find.widgetWithText(FilledButton, 'Sign out'));
      expect(find.text('Retry clearing local credentials'), findsOneWidget);
      expect(store.value, isNotNull);
      expect(revocations, 1);
      store.failClear = false;
      await tap(tester, find.text('Retry clearing local credentials'));
      expect(store.value, isNull);
      expect(revocations, 1);
      expect(tester.widget<FilledButton>(submit).onPressed, isNotNull);
    },
  );

  testWidgets(
    'a revoked session on app resume removes an open private dialog',
    (tester) async {
      var revoked = false;
      await start(tester, (request) async {
        if (request.url.path.endsWith('/me')) {
          return revoked
              ? response(errorJson('SESSION_REVOKED'), 401)
              : response(userJson());
        }
        if (request.url.path == '/api/tracked-items') {
          return response(pageJson());
        }
        if (request.url.path.endsWith('/history')) {
          return response(historyJson());
        }
        return response(trackerJson());
      }, signedIn: true);
      await tap(tester, find.text('Portal 2'));
      await tap(tester, find.text('View purchase link'));
      expect(find.text('CheapShark purchase link'), findsOneWidget);
      revoked = true;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(find.text('CheapShark purchase link'), findsNothing);
      expect(find.text('Game details'), findsNothing);
      expect(submit, findsOneWidget);
    },
  );

  testWidgets(
    'sign out clears private state and credentials while resume me is still pending',
    (tester) async {
      final resumedMe = Completer<http.Response>();
      final logout = Completer<http.Response>();
      final store = MemorySessionStore();
      var meCalls = 0, logoutCalls = 0;
      await start(
        tester,
        (request) async {
          if (request.url.path.endsWith('/me')) {
            meCalls++;
            return meCalls == 1 ? response(userJson()) : resumedMe.future;
          }
          if (request.url.path.endsWith('/logout')) {
            logoutCalls++;
            return logout.future;
          }
          return response(pageJson());
        },
        store: store,
        signedIn: true,
      );
      await tap(tester, find.byTooltip('Account and settings'));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(meCalls, 2);
      await tester.tap(find.widgetWithText(FilledButton, 'Sign out'));
      await tester.pump();
      expect(resumedMe.isCompleted, isFalse);
      expect(logoutCalls, 1);
      expect(store.value, isNull);
      expect(find.text('Account and settings'), findsNothing);
      expect(find.text('Portal 2'), findsNothing);
      expect(submit, findsOneWidget);
      logout.complete(http.Response('', 204));
      await tester.pumpAndSettle();
      resumedMe.complete(response(userJson()));
      await tester.pumpAndSettle();
      expect(find.text('Signed out.'), findsOneWidget);
      expect(store.value, isNull);
      expect(find.text('Watchlist'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'late account A watchlist cannot resurrect after logout and account B login',
    (tester) async {
      final pendingA = Completer<http.Response>();
      var account = 'A';
      await start(
        tester,
        (request) async {
          if (request.url.path.endsWith('/me')) return response(userJson());
          if (request.url.path.endsWith('/logout')) {
            return http.Response('', 204);
          }
          if (request.url.path.endsWith('/login')) {
            account = 'B';
            return response(
              freshSession()
                ..['sessionId'] = 'session_B'
                ..['user'] = (userJson()..['id'] = 'user_B'),
            );
          }
          if (account == 'A') return pendingA.future;
          return response(pageJson()..['items'] = []);
        },
        signedIn: true,
        waitForSettled: false,
      );
      await tester.pump();
      await tester.pump();
      expect(find.text('Loading watchlist…'), findsOneWidget);
      await tester.tap(find.byTooltip('Account and settings'));
      await tester.pumpAndSettle();
      await tap(tester, find.widgetWithText(FilledButton, 'Sign out'));
      await credentials(tester);
      await tap(tester, submit);
      expect(find.text('Your next game starts here.'), findsOneWidget);
      pendingA.complete(response(pageJson()));
      await tester.pumpAndSettle();
      expect(find.text('Portal 2'), findsNothing);
      expect(find.text('Your next game starts here.'), findsOneWidget);
    },
  );
}
