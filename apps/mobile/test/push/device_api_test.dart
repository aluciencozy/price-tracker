import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:price_tracker/push/device_api.dart';

const installation = 'b36d3290-4086-4a55-98d5-783cb9f24031';
final session = PushSession(
  id: 'session_example',
  bearerToken: 'fixture-bearer',
);
final deviceJson = {
  'id': 'device_example',
  'installationId': installation,
  'sessionId': session.id,
  'platform': 'android',
  'createdAt': '2026-10-28T12:00:00Z',
  'updatedAt': '2026-10-28T12:00:01.123Z',
};

Matcher failsWith(DeviceFailure reason) => throwsA(
  isA<DeviceApiException>().having((error) => error.reason, 'reason', reason),
);

void main() {
  HttpDeviceEndpoint api(
    http.Client client, {
    String origin = 'https://api.example',
    String id = installation,
  }) => HttpDeviceEndpoint(client: client, baseUrl: origin, installationId: id);

  test(
    'POST 201, rotation PUT 200 and bodyless DELETE 204 match contract',
    () async {
      final requests = <http.Request>[];
      final client = MockClient((request) async {
        requests.add(request);
        return http.Response(
          request.method == 'DELETE' ? '' : jsonEncode(deviceJson),
          request.method == 'POST'
              ? 201
              : request.method == 'PUT'
              ? 200
              : 204,
        );
      });
      addTearDown(client.close);
      final endpoint = api(client);
      final device = await endpoint.register(session, 'fixture-token');
      expect(device.id, 'device_example');
      expect(device.sessionId, session.id);
      expect(device.installationId, installation);
      expect(device.updatedAt.millisecond, 123);
      await endpoint.update(session, device.id, 'rotated-fixture-token');
      await endpoint.unregister(session, device.id);
      expect(requests.map((r) => r.method), ['POST', 'PUT', 'DELETE']);
      expect(requests.map((r) => r.url.path), [
        '/api/devices',
        '/api/devices/device_example',
        '/api/devices/device_example',
      ]);
      for (final request in requests) {
        expect(request.headers['Authorization'], 'Bearer fixture-bearer');
        expect(request.followRedirects, isFalse);
        expect(request.headers['Accept'], 'application/json');
      }
      expect(jsonDecode(requests[0].body), {
        'installationId': installation,
        'platform': 'android',
        'pushToken': 'fixture-token',
      });
      expect(jsonDecode(requests[1].body), {
        'installationId': installation,
        'platform': 'android',
        'pushToken': 'rotated-fixture-token',
      });
      expect(requests[2].body, isEmpty);
    },
  );

  test(
    'rejects unsafe origins, malformed sessions and non-UUID installations',
    () {
      final client = MockClient((_) async => http.Response('', 500));
      addTearDown(client.close);
      for (final origin in [
        'http://api.example',
        'file:///etc/passwd',
        'https://u:p@api.example',
        'https://api.example/api',
        'https://api.example?x=y',
        'https://api.example#fragment',
      ]) {
        expect(() => api(client, origin: origin), throwsArgumentError);
      }
      for (final origin in [
        'http://localhost:4000',
        'http://127.0.0.1:4000',
        'http://10.0.2.2:4000',
      ]) {
        expect(api(client, origin: origin), isA<HttpDeviceEndpoint>());
      }
      expect(() => api(client, id: 'not-a-uuid'), throwsArgumentError);
      expect(
        () => PushSession(id: 'session\n', bearerToken: 'token'),
        throwsArgumentError,
      );
      expect(
        () => PushSession(id: 'session', bearerToken: 'a\r\nb'),
        throwsArgumentError,
      );
    },
  );

  test('invalid IDs and tokens never reach HTTP', () async {
    var sent = 0;
    final client = MockClient((_) async {
      sent++;
      return http.Response('', 500);
    });
    addTearDown(client.close);
    for (final token in ['', 'with space', 'x' * 4097]) {
      await expectLater(
        api(client).register(session, token),
        failsWith(DeviceFailure.rejected),
      );
    }
    for (final id in ['../other', 'x/y', 'id\n', 'x' * 129]) {
      await expectLater(
        api(client).unregister(session, id),
        failsWith(DeviceFailure.rejected),
      );
    }
    expect(sent, 0);
  });

  for (final entry in {
    200: DeviceFailure.rejected,
    302: DeviceFailure.rejected,
    401: DeviceFailure.unauthorized,
    403: DeviceFailure.rejected,
    409: DeviceFailure.rejected,
    422: DeviceFailure.rejected,
    429: DeviceFailure.offline,
    503: DeviceFailure.offline,
  }.entries) {
    test('POST status ${entry.key} is sanitized and not success', () async {
      final client = MockClient(
        (_) async => http.Response('secret', entry.key),
      );
      addTearDown(client.close);
      await expectLater(
        api(client).register(session, 'token'),
        failsWith(entry.value),
      );
      expect(
        DeviceApiException(entry.value).toString(),
        isNot(contains('secret')),
      );
    });
  }

  test('DELETE 404 is already removed under the contract', () async {
    final client = MockClient((_) async => http.Response('', 404));
    addTearDown(client.close);
    await api(client).unregister(session, 'device_example');
    await expectLater(
      api(client).update(session, 'device_example', 'token'),
      failsWith(DeviceFailure.rejected),
    );
  });

  test(
    'Retry-After blocks even explicit calls without a second request',
    () async {
      var sent = 0;
      final client = MockClient((_) async {
        sent++;
        return http.Response('', 429, headers: {'retry-after': '120'});
      });
      addTearDown(client.close);
      final endpoint = api(client);
      for (var i = 0; i < 2; i++) {
        await expectLater(
          endpoint.register(session, 'token'),
          throwsA(
            isA<DeviceApiException>().having(
              (e) => e.retryAfterSeconds,
              'wait',
              120,
            ),
          ),
        );
      }
      expect(sent, 1);
    },
  );

  test('network errors are sanitized', () async {
    final client = MockClient(
      (_) async => throw http.ClientException('secret'),
    );
    addTearDown(client.close);
    await expectLater(
      api(client).register(session, 'token'),
      failsWith(DeviceFailure.offline),
    );
  });

  test('five-second total deadline reports offline', () async {
    final client = MockClient((_) => Completer<http.Response>().future);
    addTearDown(client.close);
    await expectLater(
      api(client).register(session, 'token'),
      failsWith(DeviceFailure.offline),
    );
  });

  test(
    'strict Device parsing rejects secrets, wrong binding and normalized dates',
    () async {
      for (final body in [
        'not-json',
        '[]',
        '{}',
        jsonEncode({...deviceJson, 'pushToken': 'secret'}),
        jsonEncode({...deviceJson, 'platform': 'ios'}),
        jsonEncode({...deviceJson, 'id': '../other'}),
        jsonEncode({...deviceJson, 'sessionId': 'other-session'}),
        jsonEncode({...deviceJson, 'installationId': 'other-installation'}),
        jsonEncode({...deviceJson, 'createdAt': '2026-02-30T12:00:00Z'}),
        jsonEncode({...deviceJson, 'updatedAt': '2026-10-28T12:00:00+00:00'}),
      ]) {
        final client = MockClient((_) async => http.Response(body, 201));
        addTearDown(client.close);
        await expectLater(
          api(client).register(session, 'token'),
          failsWith(DeviceFailure.invalidResponse),
        );
      }
      final client = MockClient(
        (_) async => http.Response(jsonEncode(deviceJson), 200),
      );
      addTearDown(client.close);
      await expectLater(
        api(client).update(session, 'other-device', 'token'),
        failsWith(DeviceFailure.invalidResponse),
      );
    },
  );
}
