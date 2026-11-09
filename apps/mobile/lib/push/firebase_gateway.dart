import 'dart:async';
import 'dart:convert';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'atomic_store.dart';
import 'integration.dart';
import 'registration.dart';
import 'storage.dart';

class FirebasePushConfig {
  const FirebasePushConfig({
    required this.enabled,
    required this.apiKey,
    required this.appId,
    required this.senderId,
    required this.projectId,
  });
  factory FirebasePushConfig.environment() => const FirebasePushConfig(
    enabled: bool.fromEnvironment('ANDROID_PUSH_ENABLED'),
    apiKey: String.fromEnvironment('FIREBASE_API_KEY'),
    appId: String.fromEnvironment('FIREBASE_APP_ID'),
    senderId: String.fromEnvironment('FIREBASE_MESSAGING_SENDER_ID'),
    projectId: String.fromEnvironment('FIREBASE_PROJECT_ID'),
  );
  final bool enabled;
  final String apiKey, appId, senderId, projectId;
  bool get configured =>
      enabled &&
      RegExp(r'^AIza[A-Za-z0-9_-]{35}$').hasMatch(apiKey) &&
      RegExp(r'^\d{6,20}$').hasMatch(senderId) &&
      RegExp('^1:$senderId:android:[a-f0-9]+\$').hasMatch(appId) &&
      RegExp(r'^[a-z][a-z0-9-]{4,28}[a-z0-9]$').hasMatch(projectId);
  FirebaseOptions get options => FirebaseOptions(
    apiKey: apiKey,
    appId: appId,
    messagingSenderId: senderId,
    projectId: projectId,
  );
}

abstract interface class PushNotificationPresenter implements PushPresenter {
  Future<void> initialize({void Function(String?)? onTap});
  Future<String?> initialPayload();
}

abstract interface class PushMessagingClient {
  Future<void> initialize(FirebaseOptions options);
  Stream<Map<String, Object?>> get messages;
  Stream<Map<String, Object?>> get opened;
  Stream<String> get tokens;
  Future<Map<String, Object?>?> initialMessage();
  Future<PushPermission> permission({required bool request});
  Future<String?> token();
}

/// Token-based SDK pinned for the existing firebase-admin send({token}) API.
class OfficialFirebaseMessagingClient implements PushMessagingClient {
  @override
  Future<void> initialize(FirebaseOptions options) async {
    await Firebase.initializeApp(options: options);
    FirebaseMessaging.onBackgroundMessage(priceTrackerBackgroundMessage);
  }

  @override
  Stream<Map<String, Object?>> get messages => FirebaseMessaging.onMessage
      .where((message) => message.notification == null)
      .map((message) => message.data);
  @override
  Stream<Map<String, Object?>> get opened => FirebaseMessaging
      .onMessageOpenedApp
      .where((message) => message.notification == null)
      .map((message) => message.data);
  @override
  Stream<String> get tokens => FirebaseMessaging.instance.onTokenRefresh;
  @override
  Future<Map<String, Object?>?> initialMessage() async {
    final message = await FirebaseMessaging.instance.getInitialMessage();
    return message?.notification == null ? message?.data : null;
  }

  @override
  Future<PushPermission> permission({required bool request}) async {
    final settings = request
        ? await FirebaseMessaging.instance.requestPermission(
            alert: true,
            badge: false,
            sound: true,
          )
        : await FirebaseMessaging.instance.getNotificationSettings();
    return settings.authorizationStatus == AuthorizationStatus.authorized
        ? PushPermission.granted
        : PushPermission.denied;
  }

  @override
  Future<String?> token() => FirebaseMessaging.instance.getToken();
}

class AndroidPushPresenter implements PushNotificationPresenter {
  AndroidPushPresenter({FlutterLocalNotificationsPlugin? plugin})
    : plugin = plugin ?? FlutterLocalNotificationsPlugin();
  final FlutterLocalNotificationsPlugin plugin;
  @override
  Future<void> initialize({void Function(String?)? onTap}) async {
    await plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('ic_stat_price_tracker'),
      ),
      onDidReceiveNotificationResponse: (response) =>
          onTap?.call(response.payload),
    );
  }

  @override
  Future<String?> initialPayload() async {
    final launch = await plugin.getNotificationAppLaunchDetails();
    return (launch?.didNotificationLaunchApp ?? false)
        ? launch?.notificationResponse?.payload
        : null;
  }

  @override
  Future<void> show(Map<String, Object?> data) => plugin.show(
    id: 1,
    title: 'Price Tracker',
    body: 'An alert is available. Sign in to check your saved games.',
    notificationDetails: const NotificationDetails(
      android: AndroidNotificationDetails(
        'price_tracker_alerts_v1',
        'Saved game alerts',
        importance: Importance.high,
        priority: Priority.high,
        onlyAlertOnce: true,
        visibility: NotificationVisibility.private,
      ),
    ),
    payload: jsonEncode(data),
  );
  @override
  Future<void> cancelAll() => plugin.cancelAll();
}

AtomicPushStorage _storage(PushPresenter presenter) => AtomicPushStorage(
  open: AtomicPushStorage.openAndroid,
  presenter: presenter,
  installation: SecurePushStorage().installationId,
);

/// The server must send data-only messages, never auto-displayed notification text.
@pragma('vm:entry-point')
Future<void> priceTrackerBackgroundMessage(RemoteMessage message) async {
  final config = FirebasePushConfig.environment();
  if (!config.configured ||
      message.notification != null ||
      const String.fromEnvironment('DATA_SOURCE', defaultValue: 'sample') !=
          'api') {
    return;
  }
  try {
    await Firebase.initializeApp(options: config.options);
    final presenter = AndroidPushPresenter();
    await presenter.initialize();
    await _storage(presenter).background(message.data);
  } catch (_) {
    /* Invalid data/storage/platform error: no fallback display. */
  }
}

class FirebasePushGateway implements PushPermissionGateway {
  FirebasePushGateway(
    this.config,
    this.dispatcher, {
    PushNotificationPresenter? presenter,
    PushMessagingClient? messaging,
  }) : presenter = presenter ?? AndroidPushPresenter(),
       messaging = messaging ?? OfficialFirebaseMessagingClient() {
    storage = _storage(this.presenter);
  }
  final FirebasePushConfig config;
  final PushEventDispatcher dispatcher;
  final PushNotificationPresenter presenter;
  final PushMessagingClient messaging;
  late final AtomicPushStorage storage;
  final List<StreamSubscription<dynamic>> _subscriptions = [];
  Future<void>? _initializing;
  bool get supported =>
      !kIsWeb &&
      defaultTargetPlatform == TargetPlatform.android &&
      config.configured;
  Future<void> initialize() =>
      _initializing ??= _initialize().catchError((Object error) async {
        await dispose();
        _initializing = null;
        throw error;
      });
  Future<void> _initialize() async {
    if (!supported) return;
    await presenter.initialize(onTap: _tap);
    await messaging.initialize(config.options);
    _subscriptions.add(
      messaging.messages.listen((data) {
        dispatcher.foreground(data).ignore();
      }, onError: (Object _) {}),
    );
    _subscriptions.add(
      messaging.tokens.listen((_) {
        dispatcher.tokenChanged().ignore();
      }, onError: (Object _) => dispatcher.tokenChanged().ignore()),
    );
    _subscriptions.add(
      messaging.opened.listen((data) {
        dispatcher.queueTap(data);
      }, onError: (Object _) {}),
    );
    _tap(await presenter.initialPayload());
    final initial = await messaging.initialMessage();
    if (initial != null) {
      dispatcher.queueTap(initial);
    }
  }

  void _tap(String? payload) {
    try {
      final data = jsonDecode(payload ?? '');
      if (data is Map<String, dynamic>) dispatcher.queueTap(data);
    } catch (_) {
      /* Ignore untrusted launch extras. */
    }
  }

  @override
  Future<PushPermission> permission({required bool request}) async {
    if (!supported) return PushPermission.unconfigured;
    await initialize();
    return messaging.permission(request: request);
  }

  @override
  Future<String?> token() async {
    if (!supported) return null;
    await initialize();
    return messaging.token();
  }

  Future<void> dispose() async {
    for (final subscription in _subscriptions) {
      await subscription.cancel();
    }
    _subscriptions.clear();
  }
}
