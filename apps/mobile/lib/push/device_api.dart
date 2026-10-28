import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'validation.dart';

/// Adapt the real auth session through PushRegistration's readSession callback.
/// Never render or log this object or its bearer token.
class PushSession {
  PushSession({required this.id, required this.bearerToken}) {
    if (!isPushId(id) ||
        bearerToken.isEmpty ||
        RegExp(r'\s').hasMatch(bearerToken)) {
      throw ArgumentError('Invalid push session');
    }
  }

  final String id;
  final String bearerToken;
}

class PushDevice {
  const PushDevice({
    required this.id,
    required this.installationId,
    required this.sessionId,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final String installationId;
  final String sessionId;
  final DateTime createdAt;
  final DateTime updatedAt;
}

enum DeviceFailure { offline, unauthorized, rejected, invalidResponse }

class DeviceApiException implements Exception {
  const DeviceApiException(this.reason, {this.retryAfterSeconds});

  final DeviceFailure reason;
  final int? retryAfterSeconds;

  @override
  String toString() => 'Device API: ${reason.name}';
}

abstract interface class DeviceEndpoint {
  Future<PushDevice> register(PushSession session, String pushToken);
  Future<PushDevice> update(
    PushSession session,
    String deviceId,
    String pushToken,
  );
  Future<void> unregister(PushSession session, String deviceId);
}

class HttpDeviceEndpoint implements DeviceEndpoint {
  HttpDeviceEndpoint({
    required this.client,
    required String baseUrl,
    required this.installationId,
  }) : _origin = Uri.parse(baseUrl) {
    final local = ['localhost', '127.0.0.1', '10.0.2.2'].contains(_origin.host);
    if (!(_origin.scheme == 'https' || (_origin.scheme == 'http' && local)) ||
        _origin.host.isEmpty ||
        _origin.userInfo.isNotEmpty ||
        _origin.hasQuery ||
        _origin.hasFragment ||
        !['', '/'].contains(_origin.path) ||
        !isInstallationId(installationId)) {
      throw ArgumentError(
        'Expected an HTTPS origin (or local HTTP) and installation UUID',
      );
    }
  }

  final http.Client client;
  final String installationId;
  final Uri _origin;
  final Stopwatch _retryClock = Stopwatch();
  int _retrySeconds = 0;

  @override
  Future<PushDevice> register(PushSession session, String pushToken) async =>
      _parseDevice(await _send('POST', session, token: pushToken), session);

  @override
  Future<PushDevice> update(
    PushSession session,
    String deviceId,
    String pushToken,
  ) async {
    final device = _parseDevice(
      await _send('PUT', session, deviceId: deviceId, token: pushToken),
      session,
    );
    if (device.id != deviceId) {
      throw const DeviceApiException(DeviceFailure.invalidResponse);
    }
    return device;
  }

  @override
  Future<void> unregister(PushSession session, String deviceId) async {
    await _send('DELETE', session, deviceId: deviceId);
  }

  Future<http.Response> _send(
    String method,
    PushSession session, {
    String? deviceId,
    String? token,
  }) async {
    if ((deviceId != null && !isPushId(deviceId)) ||
        (token != null &&
            (token.isEmpty ||
                token.length > 4096 ||
                RegExp(r'\s').hasMatch(token)))) {
      throw const DeviceApiException(DeviceFailure.rejected);
    }
    final wait = _retrySeconds - _retryClock.elapsed.inSeconds;
    if (wait > 0) {
      throw DeviceApiException(DeviceFailure.offline, retryAfterSeconds: wait);
    }
    _retrySeconds = 0;
    final request =
        http.Request(
            method,
            _origin.resolve(
              '/api/devices${deviceId == null ? '' : '/$deviceId'}',
            ),
          )
          ..followRedirects = false
          ..headers['Authorization'] = 'Bearer ${session.bearerToken}'
          ..headers['Accept'] = 'application/json';
    if (token != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode({
        'installationId': installationId,
        'platform': 'android',
        'pushToken': token,
      });
    }
    final http.Response response;
    try {
      response = await (() async => http.Response.fromStream(
        await client.send(request),
      ))().timeout(const Duration(seconds: 5));
    } on TimeoutException {
      throw const DeviceApiException(DeviceFailure.offline);
    } on http.ClientException {
      throw const DeviceApiException(DeviceFailure.offline);
    }
    if (response.statusCode == 401) {
      throw const DeviceApiException(DeviceFailure.unauthorized);
    }
    if (response.statusCode >= 500 || response.statusCode == 429) {
      final retry = int.tryParse(response.headers['retry-after'] ?? '');
      if (retry != null && retry > 0 && retry <= 9007199254740991) {
        _retrySeconds = retry;
        _retryClock
          ..reset()
          ..start();
      }
      throw DeviceApiException(
        DeviceFailure.offline,
        retryAfterSeconds: _retrySeconds > 0 ? _retrySeconds : null,
      );
    }
    // The contract explicitly treats an absent/foreign DELETE as already removed.
    if (method == 'DELETE' && response.statusCode == 404) return response;
    final expected = method == 'POST'
        ? 201
        : method == 'PUT'
        ? 200
        : 204;
    if (response.statusCode != expected) {
      throw const DeviceApiException(DeviceFailure.rejected);
    }
    return response;
  }

  PushDevice _parseDevice(http.Response response, PushSession session) {
    try {
      final data = jsonDecode(response.body);
      if (data is! Map<String, dynamic> ||
          data.length != 6 ||
          data['id'] is! String ||
          !isPushId(data['id'] as String) ||
          data['installationId'] != installationId ||
          data['sessionId'] != session.id ||
          data['platform'] != 'android' ||
          data['createdAt'] is! String ||
          data['updatedAt'] is! String) {
        throw const FormatException();
      }
      return PushDevice(
        id: data['id'] as String,
        installationId: installationId,
        sessionId: session.id,
        createdAt: parsePushTimestamp(data['createdAt'] as String),
        updatedAt: parsePushTimestamp(data['updatedAt'] as String),
      );
    } on FormatException {
      // Never propagate response bodies, which may contain secrets.
      throw const DeviceApiException(DeviceFailure.invalidResponse);
    }
  }
}
