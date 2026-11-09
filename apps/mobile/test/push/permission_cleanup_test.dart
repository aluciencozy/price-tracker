import 'dart:async';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:price_tracker/push/atomic_store.dart';
import 'package:price_tracker/push/device_api.dart';
import 'package:price_tracker/push/registration.dart';
import 'package:price_tracker/push/storage.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'atomic_store_test.dart' show RecordingPresenter;
import 'events_test.dart' show payload;
import 'registration_test.dart' show TestDevices, TestGateway;

class InstallationDevices extends TestDevices
    implements InstallationDeviceEndpoint {
  Completer<void>? paused;
  @override
  Future<void> unregisterInstallation(PushSession session) async {
    calls.add('DELETE installation ${session.id}');
    await paused?.future;
    if (removalFails) throw const DeviceApiException(DeviceFailure.offline);
  }
}

class PendingPermissionGateway extends TestGateway {
  final resultPending = Completer<PushPermission>();
  @override
  Future<PushPermission> permission({required bool request}) =>
      resultPending.future;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  sqfliteFfiInit();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test('unresolved permission prompt is not treated as denial', () async {
    final gateway = PendingPermissionGateway();
    final devices = InstallationDevices();
    final session = PushSession(id: 'session-a', bearerToken: 'fixture');
    final registration = PushRegistration(
      devices: devices,
      readSession: () => session,
      gateway: gateway,
    );
    final checking = registration.synchronize(requestPermission: true);
    await Future<void>.delayed(Duration.zero);
    expect(devices.calls, isEmpty);
    gateway.resultPending.complete(PushPermission.denied);
    await checking;
    expect(devices.calls, ['DELETE installation session-a']);
    expect(registration.status, PushStatus.denied);
  });

  test(
    'legacy restart denial uses owned installation DELETE without POST',
    () async {
      final gateway = TestGateway()..result = PushPermission.denied;
      final devices = InstallationDevices();
      final session = PushSession(id: 'session-a', bearerToken: 'fixture');
      final store = SecureDeviceBindingStore('https://api.example');
      final registration = PushRegistration(
        devices: devices,
        readSession: () => session,
        gateway: gateway,
        bindingStore: store,
      );
      await registration.synchronize(requestPermission: true);
      expect(devices.calls, ['DELETE installation session-a']);
      expect(registration.status, PushStatus.denied);
      expect(registration.revocation, PushRevocation.confirmed);
      expect(await store.read(session.id), isNull);
    },
  );

  test(
    'offline removal persists and is retried after restart before registration',
    () async {
      final session = PushSession(id: 'session-a', bearerToken: 'fixture');
      final gateway = TestGateway();
      final devices = InstallationDevices();
      final store = SecureDeviceBindingStore('https://api.example');
      PushRegistration make() => PushRegistration(
        devices: devices,
        readSession: () => session,
        gateway: gateway,
        bindingStore: store,
      );
      var registration = make();
      await registration.synchronize();
      expect((await store.read(session.id))?.deviceId, 'device-a');
      devices.removalFails = true;
      gateway.result = PushPermission.denied;
      await registration.synchronize();
      expect(registration.revocation, PushRevocation.unconfirmed);
      expect((await store.read(session.id))?.pending, true);
      registration = make();
      gateway.result = PushPermission.granted;
      await registration.synchronize();
      expect(devices.calls.last, 'DELETE installation session-a');
      expect(registration.status, isNot(PushStatus.registered));
      devices.removalFails = false;
      await registration.synchronize();
      expect(devices.calls.sublist(devices.calls.length - 2), [
        'DELETE installation session-a',
        'POST session-a fixture-token',
      ]);
      expect(registration.status, PushStatus.registered);
      expect((await store.read(session.id))?.pending, false);
    },
  );

  test('secure metadata is fenced by origin and session and contains no credentials', () async {
    final one = SecureDeviceBindingStore('https://one.example');
    await one.write(const DeviceBindingMetadata('session-a', 'device-a', true));
    expect(await one.read('session-b'), isNull);
    expect(
      await SecureDeviceBindingStore('https://two.example').read('session-a'),
      isNull,
    );
    await one.clear('session-b');
    expect((await one.read('session-a'))?.pending, true);
    final raw = await const FlutterSecureStorage().read(
      key: SecureDeviceBindingStore.key,
    );
    expect(raw, isNot(contains('fixture-token')));
    expect(raw, isNot(contains('bearer')));
  });

  test(
    'late removal of old session cannot delete or re-register the new session',
    () async {
      PushSession? session = PushSession(
        id: 'session-a',
        bearerToken: 'fixture-a',
      );
      final gateway = TestGateway()..result = PushPermission.denied;
      final devices = InstallationDevices()..paused = Completer<void>();
      final store = SecureDeviceBindingStore('https://api.example');
      final registration = PushRegistration(
        devices: devices,
        readSession: () => session,
        gateway: gateway,
        bindingStore: store,
      );
      final old = registration.synchronize();
      while (devices.calls.isEmpty) {
        await Future<void>.delayed(Duration.zero);
      }
      session = PushSession(id: 'session-b', bearerToken: 'fixture-b');
      gateway.result = PushPermission.granted;
      final next = registration.synchronize();
      devices.paused!.complete();
      await Future.wait([old, next]);
      expect(devices.calls, [
        'DELETE installation session-a',
        'POST session-b fixture-token',
      ]);
      expect((await store.read('session-b'))?.pending, false);
      expect(await store.read('session-a'), isNull);
    },
  );

  test(
    'installation DELETE is bodyless and a missing route is not success',
    () async {
      final requests = <http.Request>[];
      var status = 404;
      final client = MockClient((request) async {
        requests.add(request);
        return http.Response('', status);
      });
      addTearDown(client.close);
      final endpoint = HttpDeviceEndpoint(
        client: client,
        baseUrl: 'https://api.example',
        installationId: 'B36D3290-4086-4A55-98D5-783CB9F24031',
      );
      final session = PushSession(id: 'session-a', bearerToken: 'fixture');
      await expectLater(
        endpoint.unregisterInstallation(session),
        throwsA(isA<DeviceApiException>()),
      );
      status = 204;
      await endpoint.unregisterInstallation(session);
      expect(requests.last.method, 'DELETE');
      expect(
        requests.last.url.path,
        '/api/devices/installation/b36d3290-4086-4a55-98d5-783cb9f24031',
      );
      expect(requests.last.body, isEmpty);
    },
  );

  test('sqlite suspension survives reopen, blocks display and retains episode keys on re-enable', () async {
    final directory = await Directory.systemTemp.createTemp(
      'permission-cleanup-',
    );
    final path = '${directory.path}/push.db';
    Future<Database> open() => databaseFactoryFfi.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: 1,
        singleInstance: false,
        onConfigure: AtomicPushStorage.configure,
        onCreate: AtomicPushStorage.create,
      ),
    );
    var db = await open();
    final presenter = RecordingPresenter();
    AtomicPushStorage make() => AtomicPushStorage(
      open: () async => db,
      presenter: presenter,
      installation: () async => 'unused',
    );
    var storage = make();
    final expiry = DateTime.now().add(const Duration(days: 1));
    await storage.bindSession('session_example', expiry);
    expect(
      await storage.claim(
        sessionId: 'session_example',
        eventId: 'episode_example',
        capacity: 512,
      ),
      true,
    );
    await storage.suspendSession('session_example');
    await db.close();
    db = await open();
    storage = make();
    await storage.background({...payload(), 'eventId': 'new_episode'});
    expect(presenter.displays, 0);
    await storage.bindSession('session_example', expiry);
    expect(
      await storage.claim(
        sessionId: 'session_example',
        eventId: 'episode_example',
        capacity: 512,
      ),
      false,
    );
    await db.close();
    await directory.delete(recursive: true);
  });
}
