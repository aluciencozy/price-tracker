import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:price_tracker/push/device_api.dart';
import 'package:price_tracker/push/registration.dart';

class TestGateway implements PushPermissionGateway {
  PushPermission result = PushPermission.granted;
  String? currentToken = 'fixture-token';
  final requests = <bool>[];
  @override
  Future<PushPermission> permission({required bool request}) async {
    requests.add(request);
    return result;
  }

  @override
  Future<String?> token() async => currentToken;
}

class TestDevices implements DeviceEndpoint {
  final calls = <String>[];
  DeviceFailure? failure;
  bool removalFails = false;
  Future<PushDevice>? pending;
  PushDevice device(String owner) => PushDevice(
    id: 'device-a',
    installationId: 'b36d3290-4086-4a55-98d5-783cb9f24031',
    sessionId: owner,
    createdAt: DateTime.utc(2026, 10, 28),
    updatedAt: DateTime.utc(2026, 10, 28),
  );
  Future<PushDevice> _save(String call, String owner) async {
    calls.add(call);
    if (failure != null) {
      throw DeviceApiException(failure!, retryAfterSeconds: 60);
    }
    return pending ?? device(owner);
  }

  @override
  Future<PushDevice> register(PushSession session, String token) =>
      _save('POST ${session.id} $token', session.id);
  @override
  Future<PushDevice> update(PushSession session, String id, String token) =>
      _save('PUT ${session.id} $id $token', session.id);
  @override
  Future<void> unregister(PushSession session, String id) async {
    calls.add('DELETE ${session.id} $id');
    if (removalFails) throw const DeviceApiException(DeviceFailure.offline);
  }
}

void main() {
  late PushSession? session;
  late TestGateway gateway;
  late TestDevices devices;
  late PushRegistration registration;
  setUp(() {
    session = PushSession(id: 'session-a', bearerToken: 'fixture-bearer');
    gateway = TestGateway();
    devices = TestDevices();
    registration = PushRegistration(
      devices: devices,
      readSession: () => session,
      gateway: gateway,
    );
  });

  test(
    'default remains unconfigured, even on explicit permission request',
    () async {
      final unconfigured = PushRegistration(
        devices: devices,
        readSession: () => session,
      );
      expect(unconfigured.status, PushStatus.unconfigured);
      await unconfigured.synchronize(requestPermission: true);
      expect(unconfigured.status, PushStatus.unconfigured);
      expect(devices.calls, isEmpty);
      expect(await const UnconfiguredPushGateway().token(), isNull);
    },
  );

  test('denied and no token are distinct and never register', () async {
    gateway.result = PushPermission.denied;
    await registration.synchronize(requestPermission: true);
    expect(registration.status, PushStatus.denied);
    gateway.result = PushPermission.granted;
    gateway.currentToken = null;
    await registration.synchronize();
    expect(registration.status, PushStatus.noToken);
    expect(gateway.requests, [true, false]);
    expect(devices.calls, isEmpty);
  });

  test(
    'concurrent calls serialize; registered only after API success',
    () async {
      final result = Completer<PushDevice>();
      devices.pending = result.future;
      final first = registration.synchronize();
      final second = registration.synchronize();
      await Future<void>.delayed(Duration.zero);
      expect(registration.status, PushStatus.unconfigured);
      result.complete(devices.device('session-a'));
      await Future.wait([first, second]);
      expect(registration.status, PushStatus.registered);
      expect(devices.calls, ['POST session-a fixture-token']);
    },
  );

  test(
    'rotation uses PUT on same device instead of another registration',
    () async {
      await registration.synchronize();
      gateway.currentToken = 'rotated';
      await registration.synchronize();
      expect(devices.calls, [
        'POST session-a fixture-token',
        'PUT session-a device-a rotated',
      ]);
      expect(registration.status, PushStatus.registered);
    },
  );

  test('offline is not registered; explicit retry recovers but uncertainty remains', () async {
    devices.failure = DeviceFailure.offline;
    await registration.synchronize();
    expect(registration.status, PushStatus.offline);
    expect(registration.retryAfterSeconds, 60);
    expect(registration.revocation, PushRevocation.unconfirmed);
    devices.failure = null;
    await registration.synchronize();
    expect(registration.status, PushStatus.registered);
    expect(registration.retryAfterSeconds, isNull);
  });

  test('401 is an error, not permission denied or registered', () async {
    devices.failure = DeviceFailure.unauthorized;
    await registration.synchronize();
    expect(registration.status, PushStatus.error);
  });

  test(
    'account switch clears status immediately and unregisters as old session',
    () async {
      await registration.synchronize();
      session = PushSession(id: 'session-b', bearerToken: 'other-bearer');
      final switching = registration.synchronize();
      expect(registration.status, PushStatus.unconfigured);
      await switching;
      expect(devices.calls, [
        'POST session-a fixture-token',
        'DELETE session-a device-a',
        'POST session-b fixture-token',
      ]);
      expect(registration.revocation, PushRevocation.confirmed);
    },
  );

  test('offline logout clears context and never claims revocation', () async {
    await registration.synchronize();
    devices.removalFails = true;
    session = null;
    final logout = registration.synchronize();
    expect(registration.status, PushStatus.signedOut);
    await logout;
    expect(registration.revocation, PushRevocation.unconfirmed);
    devices.removalFails = false;
    session = PushSession(id: 'session-b', bearerToken: 'other-bearer');
    await registration.synchronize();
    session = null;
    await registration.synchronize();
    expect(registration.revocation, PushRevocation.unconfirmed);
  });

  test(
    'ambiguous registration without device ID cannot confirm logout cleanup',
    () async {
      devices.failure = DeviceFailure.offline;
      await registration.synchronize();
      session = null;
      await registration.synchronize();
      expect(registration.status, PushStatus.signedOut);
      expect(registration.revocation, PushRevocation.unconfirmed);
      expect(devices.calls.where((c) => c.startsWith('DELETE')), isEmpty);
    },
  );

  test(
    'denied permission and lost token each unregister previous binding',
    () async {
      await registration.synchronize();
      gateway.result = PushPermission.denied;
      await registration.synchronize();
      expect(registration.status, PushStatus.denied);
      gateway.result = PushPermission.granted;
      await registration.synchronize();
      gateway.currentToken = null;
      await registration.synchronize();
      expect(registration.status, PushStatus.noToken);
      expect(devices.calls.where((c) => c.startsWith('DELETE')).length, 2);
    },
  );

  for (final rotating in [false, true]) {
    test(
      'logout during ${rotating ? 'PUT' : 'POST'} cleans late success once',
      () async {
        if (rotating) await registration.synchronize();
        final result = Completer<PushDevice>();
        devices.pending = result.future;
        gateway.currentToken = 'rotated';
        final saving = registration.synchronize();
        await Future<void>.delayed(Duration.zero);
        session = null;
        final logout = registration.synchronize();
        result.complete(devices.device('session-a'));
        await Future.wait([saving, logout]);
        expect(registration.status, PushStatus.signedOut);
        expect(devices.calls.where((c) => c.startsWith('DELETE')).length, 1);
        expect(registration.revocation, PushRevocation.confirmed);
      },
    );
  }
}
