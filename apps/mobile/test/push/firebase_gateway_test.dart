import 'dart:async';
import 'dart:convert';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:price_tracker/app_config.dart';
import 'package:price_tracker/push/events.dart';
import 'package:price_tracker/push/firebase_gateway.dart';
import 'package:price_tracker/push/integration.dart';
import 'package:price_tracker/push/registration.dart';

import 'events_test.dart' show payload;

class FixtureMessaging implements PushMessagingClient {
  int initializations = 0, tokenReads = 0;
  bool fail = false;
  PushPermission allowed = PushPermission.granted;
  String? currentToken = 'fixture-fcm-registration-token';
  Map<String, Object?>? launch;
  final requests = <bool>[];
  final incoming = StreamController<Map<String, Object?>>.broadcast();
  final taps = StreamController<Map<String, Object?>>.broadcast();
  final rotations = StreamController<String>.broadcast();
  @override
  Future<void> initialize(FirebaseOptions options) async {
    initializations++;
    if (fail) throw StateError('fixture init failure');
  }

  @override
  Stream<Map<String, Object?>> get messages => incoming.stream;
  @override
  Stream<Map<String, Object?>> get opened => taps.stream;
  @override
  Stream<String> get tokens => rotations.stream;
  @override
  Future<Map<String, Object?>?> initialMessage() async => launch;
  @override
  Future<PushPermission> permission({required bool request}) async {
    requests.add(request);
    return allowed;
  }

  @override
  Future<String?> token() async {
    tokenReads++;
    return currentToken;
  }

  Future<void> close() async {
    await incoming.close();
    await taps.close();
    await rotations.close();
  }
}

class FixtureNotifications implements PushNotificationPresenter {
  int initializations = 0;
  String? launch;
  void Function(String?)? tap;
  @override
  Future<void> initialize({void Function(String?)? onTap}) async {
    initializations++;
    tap = onTap;
  }

  @override
  Future<String?> initialPayload() async => launch;
  @override
  Future<void> show(Map<String, Object?> data) async {}
  @override
  Future<void> cancelAll() async {}
}

class RecordingDispatcher extends PushEventDispatcher {
  int refreshes = 0;
  final foregrounds = <Map<String, Object?>>[], taps = <Map<String, Object?>>[];
  @override
  Future<ForegroundPushResult> foreground(Map<String, Object?> data) async {
    foregrounds.add(data);
    return ForegroundPushResult.accepted;
  }

  @override
  void queueTap(Map<String, Object?> data) => taps.add(data);
  @override
  Future<void> tokenChanged() async {
    refreshes++;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('background gate uses build source policy and fails closed', () {
    bool allowed(
      AppConfig Function() load, {
      bool configured = true,
      bool notification = false,
    }) => backgroundPushAllowed(
      configured: configured,
      hasNotification: notification,
      loadConfig: load,
    );
    AppConfig build({String? source, String? url, required bool release}) =>
        AppConfig.fromBuildValues(
          source: source,
          apiBaseUrl: url,
          isRelease: release,
        );
    expect(allowed(() => build(release: true)), isTrue);
    expect(allowed(() => build(release: false)), isFalse);
    expect(allowed(() => build(source: 'sample', release: true)), isFalse);
    expect(allowed(() => build(source: 'wrong', release: true)), isFalse);
    expect(allowed(() => build(url: 'https://[', release: true)), isFalse);
    expect(allowed(() => build(release: true), configured: false), isFalse);
    expect(allowed(() => build(release: true), notification: true), isFalse);
  });
  final configured = FirebasePushConfig(
    enabled: true,
    apiKey: 'AIza${List.filled(35, 'x').join()}',
    appId: '1:123456789:android:abcdef1234',
    senderId: '123456789',
    projectId: 'fixture-project',
  );
  late FixtureMessaging messaging;
  late FixtureNotifications presenter;
  late RecordingDispatcher dispatcher;
  late FirebasePushGateway gateway;
  setUp(() {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    messaging = FixtureMessaging();
    presenter = FixtureNotifications();
    dispatcher = RecordingDispatcher();
    gateway = FirebasePushGateway(
      configured,
      dispatcher,
      messaging: messaging,
      presenter: presenter,
    );
  });
  tearDown(() async {
    await gateway.dispose();
    await messaging.close();
    debugDefaultTargetPlatformOverride = null;
  });
  test(
    'real Android presenter sends generic text, stable ID and onlyAlertOnce',
    () async {
      AndroidFlutterLocalNotificationsPlugin.registerWith();
      const channel = MethodChannel(
        'dexterous.com/flutter/local_notifications',
      );
      final calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            calls.add(call);
            return call.method == 'initialize' ? true : null;
          });
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null),
      );
      final native = AndroidPushPresenter();
      await native.initialize();
      await native.show(payload());
      await native.show({...payload(), 'eventId': 'another_episode'});
      await native.cancelAll();
      final shown = calls.where((call) => call.method == 'show').toList();
      expect(shown, hasLength(2));
      for (final call in shown) {
        final data = call.arguments as Map;
        expect(data['id'], 1);
        expect(data['title'], 'Price Tracker');
        expect(
          data['body'],
          'An alert is available. Sign in to check your saved games.',
        );
        expect((data['platformSpecifics'] as Map)['onlyAlertOnce'], true);
        expect(
          (data['platformSpecifics'] as Map)['channelId'],
          'price_tracker_alerts_v1',
        );
      }
      expect(calls.last.method, 'cancelAll');
    },
  );
  test(
    'disabled or missing/malformed configuration never initializes a plugin',
    () async {
      for (final config in [
        FirebasePushConfig(
          enabled: false,
          apiKey: configured.apiKey,
          appId: configured.appId,
          senderId: configured.senderId,
          projectId: configured.projectId,
        ),
        const FirebasePushConfig(
          enabled: true,
          apiKey: '',
          appId: '',
          senderId: '',
          projectId: '',
        ),
        const FirebasePushConfig(
          enabled: true,
          apiKey: 'not-a-key',
          appId: 'not-an-app',
          senderId: 'bad',
          projectId: 'bad',
        ),
      ]) {
        final disabled = FirebasePushGateway(
          config,
          dispatcher,
          messaging: messaging,
          presenter: presenter,
        );
        await disabled.initialize();
        expect(
          await disabled.permission(request: true),
          PushPermission.unconfigured,
        );
        expect(await disabled.token(), isNull);
        await disabled.dispose();
      }
      expect(messaging.initializations, 0);
      expect(messaging.tokenReads, 0);
      expect(presenter.initializations, 0);
    },
  );
  test('unsupported platform never initializes Firebase', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    expect(
      await gateway.permission(request: true),
      PushPermission.unconfigured,
    );
    expect(messaging.initializations, 0);
  });
  test(
    'permission reads do not prompt; only explicit request prompts',
    () async {
      messaging.allowed = PushPermission.denied;
      expect(await gateway.permission(request: false), PushPermission.denied);
      messaging.allowed = PushPermission.granted;
      expect(await gateway.permission(request: true), PushPermission.granted);
      expect(messaging.requests, [false, true]);
      expect(messaging.initializations, 1);
      expect(messaging.tokenReads, 0);
      expect(await gateway.token(), messaging.currentToken);
    },
  );
  test(
    'refresh, foreground and opened streams use existing dispatcher',
    () async {
      await gateway.initialize();
      messaging.incoming.add(payload());
      messaging.taps.add(payload());
      messaging.rotations.add('rotated-registration-token');
      await Future<void>.delayed(Duration.zero);
      expect(dispatcher.foregrounds, [payload()]);
      expect(dispatcher.taps, [payload()]);
      expect(dispatcher.refreshes, 1);
      await gateway.dispose();
      messaging.incoming.add(payload());
      messaging.rotations.add('later');
      await Future<void>.delayed(Duration.zero);
      expect(dispatcher.foregrounds, hasLength(1));
      expect(dispatcher.refreshes, 1);
    },
  );
  test(
    'local cold-start payload and warm tap are queued, never raw routes',
    () async {
      presenter.launch = jsonEncode(payload());
      await gateway.initialize();
      expect(dispatcher.taps, [payload()]);
      presenter.tap?.call(jsonEncode(payload()));
      presenter.tap?.call('https://untrusted.example');
      expect(dispatcher.taps, hasLength(2));
    },
  );
  test(
    'Firebase cold start is also queued for authenticated navigation',
    () async {
      messaging.launch = payload();
      await gateway.initialize();
      expect(dispatcher.taps, [payload()]);
    },
  );
  test(
    'initialization failure is retryable without duplicate stream listeners',
    () async {
      messaging.fail = true;
      await expectLater(gateway.initialize(), throwsStateError);
      messaging.fail = false;
      await gateway.initialize();
      messaging.rotations.add('rotation');
      await Future<void>.delayed(Duration.zero);
      expect(dispatcher.refreshes, 1);
      expect(messaging.initializations, 2);
    },
  );
}
