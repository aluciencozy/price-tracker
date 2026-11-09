import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:price_tracker/client/mobile_api.dart';
import 'package:price_tracker/client/session_controller.dart';
import 'package:price_tracker/push/atomic_store.dart';
import 'package:price_tracker/push/integration.dart';
import 'package:price_tracker/push/registration.dart';
import 'package:price_tracker/push/storage.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../client_fixtures.dart';
import '../client_fixtures.dart' as fixtures show now;
import '../session_controller_test.dart' show MemorySessionStore;
import 'atomic_store_test.dart' show RecordingPresenter;
import 'events_test.dart' show payload;
import 'registration_test.dart' show TestDevices, TestGateway;
import 'permission_cleanup_test.dart' show InstallationDevices;

class ObservedAtomicStorage extends AtomicPushStorage {
  ObservedAtomicStorage(Database db, RecordingPresenter presenter)
    : super(
        open: () async => db,
        presenter: presenter,
        installation: () async => 'unused',
        now: () => fixtures.now,
      );
  final bindings = <String?>[];
  final firstBinding = Completer<void>();
  @override
  Future<void> bindSession(String? id, DateTime? expiresAt) async {
    bindings.add(id);
    await super.bindSession(id, expiresAt);
    if (!firstBinding.isCompleted) firstBinding.complete();
  }

  @override
  Future<void> prepareSession(String id, DateTime expiresAt) async {
    bindings.add(id);
    await super.prepareSession(id, expiresAt);
    if (!firstBinding.isCompleted) firstBinding.complete();
  }
}

class StartupPresenter extends RecordingPresenter {
  Completer<void>? cancelEntered, cancelRelease;
  @override
  Future<void> cancelAll() async {
    await super.cancelAll();
    cancelEntered?.complete();
    await cancelRelease?.future;
  }
}

void main() {
  sqfliteFfiInit();
  late Directory directory;
  late List<Database> connections;
  late Database db;
  late StartupPresenter presenter;
  late MemorySessionStore credentials;
  late ObservedAtomicStorage storage;
  late SessionController session;
  late PushIntegrationController integration;
  late void Function() stop;
  late Future<http.Response> Function(http.Request) reply;
  late List<http.Request> requests;

  Future<Database> connect() async {
    final connection = await databaseFactoryFfi.openDatabase(
      '${directory.path}/receipts.db',
      options: OpenDatabaseOptions(
        version: 1,
        singleInstance: false,
        onConfigure: AtomicPushStorage.configure,
        onCreate: AtomicPushStorage.create,
      ),
    );
    connections.add(connection);
    return connection;
  }

  void start({
    TestDevices? devices,
    PushPermissionGateway gateway = const UnconfiguredPushGateway(),
    DeviceBindingStore? bindingStore,
  }) {
    final client = MockClient((request) {
      requests.add(request);
      return reply(request);
    });
    final api = MobileApi(
      client: client,
      baseUrl: 'https://api.example.test',
      now: () => now,
    );
    session = SessionController(api: api, store: credentials, now: () => now);
    storage = ObservedAtomicStorage(db, presenter);
    integration = PushIntegrationController(
      session: session,
      devices: devices ?? TestDevices(),
      storage: storage,
      gateway: gateway,
      bindingStore: bindingStore,
    );
    final capturedSession = session;
    final capturedIntegration = integration;
    var stopped = false;
    stop = () {
      if (stopped) return;
      stopped = true;
      capturedIntegration.dispose();
      capturedSession.dispose();
      client.close();
    };
    addTearDown(stop);
  }

  Future<void> reconciled() =>
      storage.firstBinding.future.timeout(const Duration(seconds: 2));
  Future<void> expectSignedOut() async {
    expect(session.activeSession, isNull);
    expect(await db.query('session'), isEmpty);
    await reconciled();
    await storage.background({
      ...payload(),
      'eventId': 'accepted_before_process_death',
    });
    expect(presenter.displays, 0);
  }

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('push-startup-test-');
    connections = [];
    presenter = StartupPresenter();
    credentials = MemorySessionStore()..value = jsonEncode(sessionJson());
    requests = [];
    reply = (_) async => http.Response(jsonEncode(userJson()), 200);
    // Prior process: authenticated binding and a handled episode are durable.
    final prior = await connect();
    final priorStorage = ObservedAtomicStorage(prior, presenter);
    await priorStorage.bindSession(
      'session_example',
      now.add(const Duration(days: 7)),
    );
    expect(
      await priorStorage.claim(
        sessionId: 'session_example',
        eventId: 'episode_example',
        capacity: 512,
      ),
      true,
    );
    await prior.close();
    connections.remove(prior);
    db = await connect(); // A new connection/process does not inherit Dart state.
    presenter.cancellations = 0;
  });
  tearDown(() async {
    final release = presenter.cancelRelease;
    if (release != null && !release.isCompleted) release.complete();
    for (final connection in connections) {
      await connection.close();
    }
    await directory.delete(recursive: true);
  });

  test('restart after credential deletion/process death clears the orphaned active binding', () async {
    // Crash gap: secure deletion committed, but native deactivation never ran.
    await credentials.clear();
    credentials.reading = Completer<String?>();
    start();
    expect(storage.bindings, isEmpty);
    final restoring = session.restore();
    await Future<void>.delayed(Duration.zero);
    expect(storage.bindings, isEmpty);
    expect(await db.query('session'), hasLength(1));
    credentials.reading!.complete(null);
    await restoring;
    await expectSignedOut();
    expect(requests, isEmpty);
    expect(presenter.cancellations, greaterThan(0));
  });

  test('restored denied session suspends SQLite even when owned removal is offline', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final devices = InstallationDevices()..removalFails = true;
    final gateway = TestGateway()..result = PushPermission.denied;
    start(
      devices: devices,
      gateway: gateway,
      bindingStore: SecureDeviceBindingStore('https://api.example.test'),
    );
    await session.restore();
    await integration.registration.synchronize();
    expect(integration.registration.status, PushStatus.denied);
    expect(integration.registration.revocation, PushRevocation.unconfirmed);
    expect((await db.query('session')).single['expires'], 0);
    expect(await db.query('receipts'), hasLength(1));
    await storage.background({...payload(), 'eventId': 'after_denial'});
    expect(presenter.displays, 0);
    devices.removalFails = false;
    gateway.result = PushPermission.granted;
    await integration.registration.synchronize();
    expect(integration.registration.status, PushStatus.registered);
    expect(
      await storage.claim(
        sessionId: 'session_example',
        eventId: 'episode_example',
        capacity: 512,
      ),
      false,
    );
  });

  test(
    'empty startup waits for native deactivation and cannot race a new login',
    () async {
      await credentials.clear();
      presenter.cancelEntered = Completer<void>();
      presenter.cancelRelease = Completer<void>();
      start();
      var restored = false;
      final restoring = session.restore().then((_) => restored = true);
      await presenter.cancelEntered!.future;
      expect(restored, false);
      await expectLater(
        session.login('new@example.test', 'fixture'),
        throwsA(
          isA<ApiFailure>().having((error) => error.code, 'code', 'BUSY'),
        ),
      );
      presenter.cancelRelease!.complete();
      presenter.cancelEntered = null;
      await restoring;
      await expectSignedOut();
      expect(restored, true);
      expect(requests, isEmpty);
    },
  );

  test('empty startup cleanup failure blocks login until explicit cleanup succeeds', () async {
    await credentials.clear();
    presenter.failCancel = true;
    start();
    await expectLater(
      session.restore(),
      throwsA(
        isA<ApiFailure>().having((error) => error.code, 'code', 'STORAGE'),
      ),
    );
    expect(session.cleanupRequired, true);
    expect(await db.query('session'), isEmpty);
    await expectLater(
      session.login('new@example.test', 'fixture'),
      throwsA(
        isA<ApiFailure>().having((error) => error.code, 'code', 'STORAGE'),
      ),
    );
    presenter.failCancel = false;
    await session.logout();
    await expectSignedOut();
    expect(session.cleanupRequired, false);
  });

  test('pending secure read never clears a valid same-session receipt; restore keeps dedup', () async {
    credentials.reading = Completer<String?>();
    start();
    final restoring = session.restore();
    await Future<void>.delayed(Duration.zero);
    expect(storage.bindings, isEmpty);
    expect(presenter.cancellations, 0);
    expect(await db.query('receipts'), hasLength(1));
    credentials.reading!.complete(credentials.value);
    await restoring;
    await reconciled();
    expect(storage.bindings, ['session_example']);
    expect(presenter.cancellations, 0);
    await storage.background(payload());
    expect(presenter.displays, 0);
    expect(await db.query('receipts'), hasLength(1));
  });

  test('pending authenticated me check must not clear before same-session validation', () async {
    final checked = Completer<http.Response>();
    reply = (_) => checked.future;
    start();
    final restoring = session.restore();
    await Future<void>.delayed(Duration.zero);
    expect(requests, hasLength(1));
    expect(storage.bindings, isEmpty);
    expect(await db.query('receipts'), hasLength(1));
    checked.complete(http.Response(jsonEncode(userJson()), 200));
    await restoring;
    await reconciled();
    expect(
      await storage.claim(
        sessionId: 'session_example',
        eventId: 'episode_example',
        capacity: 512,
      ),
      false,
    );
    expect(presenter.cancellations, 0);
  });

  for (final failure in ['rejected', 'expired', 'malformed']) {
    test(
      '$failure restoration deactivates the previous process binding',
      () async {
        if (failure == 'expired') {
          credentials.value = jsonEncode(
            sessionJson()..['expiresAt'] = now.toIso8601String(),
          );
        } else if (failure == 'malformed') {
          credentials.value = 'invalid session';
        } else {
          reply = (_) async =>
              http.Response(jsonEncode(errorJson('SESSION_REVOKED')), 401);
        }
        start();
        await expectLater(session.restore(), throwsA(isA<ApiFailure>()));
        await expectSignedOut();
        expect(credentials.value, isNull);
      },
    );
  }

  test(
    'disposed pending restoration cannot clear a replacement account binding',
    () async {
      final read = Completer<String?>();
      credentials.reading = read;
      start();
      final oldRestore = session.restore();
      await Future<void>.delayed(Duration.zero);
      stop();
      // Model the replacement owner's durable binding on a separate connection.
      final replacement = await connect();
      final replacementStorage = ObservedAtomicStorage(replacement, presenter);
      await replacementStorage.bindSession(
        'session_B',
        now.add(const Duration(days: 7)),
      );
      expect(
        await replacementStorage.claim(
          sessionId: 'session_B',
          eventId: 'episode_B',
          capacity: 512,
        ),
        true,
      );
      read.complete(null);
      await oldRestore;
      expect((await replacement.query('session')).single['id'], 'session_B');
      expect(
        await replacementStorage.claim(
          sessionId: 'session_B',
          eventId: 'episode_B',
          capacity: 512,
        ),
        false,
      );
    },
  );
}
