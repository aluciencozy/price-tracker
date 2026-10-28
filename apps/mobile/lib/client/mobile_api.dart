import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:http/http.dart' as http;

import 'models.dart';

class FieldError {
  FieldError.fromJson(Json json)
    : path = jsonString(json['path'], 300),
      code = jsonString(json['code']),
      message = jsonString(json['message'], 300) {
    requireKeys(json, ['path', 'code', 'message']);
    if (!path.startsWith('/') ||
        ![
          'required',
          'unknown_field',
          'invalid_type',
          'out_of_range',
          'invalid_format',
          'unsupported',
          'invalid_value',
        ].contains(code)) {
      invalidJson();
    }
  }
  final String path, code, message;
}

class ApiFailure implements Exception {
  const ApiFailure(
    this.code,
    this.message, {
    this.status,
    this.fields = const [],
    this.requestId,
    this.retryAfterSeconds,
    this.resourceId,
  });
  final String code, message;
  final int? status, retryAfterSeconds;
  final List<FieldError> fields;
  final String? requestId, resourceId;
  @override
  String toString() => 'ApiFailure($code)';
}

/// Native-only API transport. The caller owns the injected client's lifetime.
class MobileApi {
  MobileApi({
    required this.client,
    required String baseUrl,
    this.timeout = const Duration(seconds: 10),
    DateTime Function()? now,
  }) : _origin = Uri.parse(baseUrl),
       _now = now ?? DateTime.now {
    // Same origin-only syntax as HealthApi; never resolve a submitted URL.
    if (!['http', 'https'].contains(_origin.scheme) ||
        _origin.host.isEmpty ||
        _origin.userInfo.isNotEmpty ||
        _origin.hasQuery ||
        _origin.hasFragment ||
        !['', '/'].contains(_origin.path)) {
      throw ArgumentError(
        'API_BASE_URL must be an HTTP(S) origin without credentials.',
      );
    }
    if (_origin.scheme == 'http' &&
        (!kDebugMode ||
            !['localhost', '127.0.0.1', '10.0.2.2'].contains(_origin.host))) {
      throw ArgumentError(
        'API credentials require HTTPS except local debug hosts.',
      );
    }
    if (timeout <= Duration.zero) throw ArgumentError('Invalid timeout.');
  }

  final http.Client client;
  final Uri _origin;
  final Duration timeout;
  final DateTime Function() _now;
  String? _token;
  DateTime? _expiresAt;
  int _generation = 0;
  Future<void> Function()? onUnauthorized;

  // SessionController owns this state; UI account actions go through it.
  void setSession(Session? session) {
    if (session == null && _token == null) return;
    _token = session?.accessToken;
    _expiresAt = session?.expiresAt;
    _generation++;
  }

  Future<void> _invalidate() async {
    setSession(null);
    await onUnauthorized?.call();
  }

  Future<T> _request<T>(
    String method,
    String path,
    T Function(Json) parse, {
    bool authenticated = true,
    Json? body,
    Map<String, String>? query,
    Map<String, String>? headers,
    int status = 200,
    bool endingSession = false,
  }) async {
    if (authenticated && _token == null) {
      throw const ApiFailure('AUTH_REQUIRED', 'Please sign in.');
    }
    if (authenticated && !_expiresAt!.isAfter(_now())) {
      await _invalidate();
      throw const ApiFailure('SESSION_EXPIRED', 'Please sign in again.');
    }
    final abort = Completer<void>();
    final request = http.AbortableRequest(
      method,
      _origin.resolve(path).replace(queryParameters: query),
      abortTrigger: abort.future,
    )..followRedirects = false;
    request.headers.addAll({
      'Accept': 'application/json',
      if (authenticated) 'Authorization': 'Bearer $_token',
      ...?headers,
    });
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    // Logout retains its captured header but immediately blocks other requests
    // and invalidates private responses from before sign-out.
    if (endingSession) setSession(null);
    final generation = _generation;
    try {
      final response =
          await (() async {
            final stream = await client.send(request);
            final bytes = <int>[];
            await for (final chunk in stream.stream) {
              if (bytes.length + chunk.length > 1024 * 1024) {
                throw const FormatException('Response too large');
              }
              bytes.addAll(chunk);
            }
            return http.Response.bytes(
              bytes,
              stream.statusCode,
              headers: stream.headers,
            );
          })().timeout(
            timeout,
            onTimeout: () {
              abort.complete();
              throw TimeoutException('API deadline');
            },
          );
      if (authenticated && generation != _generation) {
        throw const ApiFailure('SESSION_CHANGED', 'Please sign in again.');
      }
      if (authenticated && !endingSession && !_expiresAt!.isAfter(_now())) {
        await _invalidate();
        throw const ApiFailure('SESSION_EXPIRED', 'Please sign in again.');
      }
      if (authenticated && response.statusCode == 401) await _invalidate();
      if (response.statusCode != status) throw _error(response);
      if (status == 204) {
        if (response.bodyBytes.isNotEmpty) invalidJson();
        return parse({});
      }
      return parse(jsonObject(jsonDecode(utf8.decode(response.bodyBytes))));
    } on TimeoutException {
      throw const ApiFailure('TIMEOUT', 'The API timed out. Please try again.');
    } on http.ClientException {
      throw const ApiFailure(
        'OFFLINE',
        'Could not reach the API. Please try again.',
      );
    } on IOException {
      throw const ApiFailure(
        'OFFLINE',
        'Could not reach the API. Please try again.',
      );
    } on FormatException {
      throw const ApiFailure('INVALID_RESPONSE', 'Unexpected API response.');
    }
  }

  static ApiFailure _error(http.Response response) {
    try {
      final envelope = jsonObject(jsonDecode(utf8.decode(response.bodyBytes)));
      requireKeys(envelope, ['error']);
      final error = jsonObject(envelope['error']);
      requireKeys(error, [
        'code',
        'message',
        'fields',
        'requestId',
        'retryAfterSeconds',
        'resourceId',
      ]);
      if (!{
        'MALFORMED_REQUEST',
        'AUTH_AMBIGUOUS',
        'TOKEN_INVALID',
        'AUTH_REQUIRED',
        'INVALID_CREDENTIALS',
        'SESSION_EXPIRED',
        'SESSION_REVOKED',
        'EMAIL_UNVERIFIED',
        'CSRF_INVALID',
        'ORIGIN_DENIED',
        'ADMIN_REQUIRED',
        'NOT_FOUND',
        'DUPLICATE_TRACKED_ITEM',
        'IDEMPOTENCY_CONFLICT',
        'DEVICE_CONFLICT',
        'PREVIEW_EXPIRED',
        'VALIDATION_ERROR',
        'INVALID_CURSOR',
        'UNSUPPORTED_URL',
        'UNSUPPORTED_PRODUCT',
        'AMBIGUOUS_PRODUCT',
        'STEAM_OFFER_UNAVAILABLE',
        'RATE_LIMITED',
        'PROVIDER_RATE_LIMITED',
        'SERVICE_UNAVAILABLE',
        'PROVIDER_UNAVAILABLE',
        'PAYLOAD_TOO_LARGE',
        'UNSUPPORTED_MEDIA_TYPE',
        'INTERNAL_ERROR',
      }.contains(error['code'])) {
        invalidJson();
      }
      final retry = error['retryAfterSeconds'] == null
          ? null
          : jsonInteger(error['retryAfterSeconds']);
      if (retry == 0) invalidJson();
      final headerRetry = int.tryParse(response.headers['retry-after'] ?? '');
      final wait =
          headerRetry != null &&
              headerRetry > 0 &&
              headerRetry <= 9007199254740991 &&
              headerRetry > (retry ?? 0)
          ? headerRetry
          : retry;
      return ApiFailure(
        jsonString(error['code']),
        jsonString(error['message'], 500),
        status: response.statusCode,
        fields: jsonList(error['fields'], FieldError.fromJson, 50),
        requestId: jsonId(error['requestId']),
        retryAfterSeconds: wait,
        resourceId: error['resourceId'] == null
            ? null
            : jsonId(error['resourceId']),
      );
    } on FormatException {
      // Proxy HTML, stack traces, malformed JSON and arbitrary response bodies
      // must not become user-facing errors or leak into logs.
      return ApiFailure(
        'INVALID_RESPONSE',
        'The API returned an unexpected error.',
        status: response.statusCode,
      );
    }
  }

  Future<Session> login(String email, String password) => _request(
    'POST',
    '/api/auth/mobile/login',
    (json) {
      final session = Session.fromJson(json);
      if (session.expired(_now())) invalidJson();
      return session;
    },
    authenticated: false,
    body: {'email': email, 'password': password},
  );
  Future<User> me() => _request('GET', '/api/auth/mobile/me', User.fromJson);
  Future<void> logout() => _request(
    'POST',
    '/api/auth/mobile/logout',
    (_) {},
    status: 204,
    endingSession: true,
  );
  Future<void> register({
    required String email,
    required String password,
    String? name,
  }) => _accepted('register', {
    'email': email,
    'password': password,
    'name': ?name,
  });
  Future<void> resendVerification(String email) =>
      _accepted('resend-verification', {'email': email});
  Future<void> forgotPassword(String email) =>
      _accepted('forgot-password', {'email': email});

  // Verification/reset tokens are intentionally consumed by browser actions,
  // not native deep links or automatic email-link GET requests.
  Future<void> _accepted(String operation, Json body) => _request(
    'POST',
    '/api/auth/mobile/$operation',
    (json) {
      requireKeys(json, ['message']);
      if (json['message'] !=
          'If eligible, you will receive an email with next steps.') {
        invalidJson();
      }
    },
    authenticated: false,
    body: body,
    status: 202,
  );

  Future<ProductPreview> preview(String url) => _request(
    'POST',
    '/api/product-previews',
    ProductPreview.fromJson,
    body: {'url': url},
    status: 201,
  );
  Future<Page<TrackedItem>> list({
    String? search,
    String? cursor,
    int limit = 20,
  }) => _request('GET', '/api/tracked-items', (json) {
    requireKeys(json, ['items', 'page']);
    return Page.fromJson(json, TrackedItem.fromJson);
  }, query: _query(cursor, limit, {'q': ?search}));
  Future<TrackedItem> get(String id) => _request(
    'GET',
    '/api/tracked-items/${_id(id)}',
    (json) => _ownedItem(json, id),
  );
  Future<TrackedItem> create({
    required String previewId,
    required Money targetPrice,
    required bool enabled,
    required Alerts alerts,
    required String idempotencyKey,
  }) {
    if (!RegExp(
      r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    ).hasMatch(idempotencyKey)) {
      throw ArgumentError('A UUID Idempotency-Key is required.');
    }
    return _request(
      'POST',
      '/api/tracked-items',
      TrackedItem.fromJson,
      status: 201,
      headers: {'Idempotency-Key': idempotencyKey},
      body: {
        'previewId': _id(previewId),
        'targetPrice': targetPrice.toJson(),
        'enabled': enabled,
        'alerts': alerts.toJson(),
      },
    );
  }

  Future<TrackedItem> update(
    String id, {
    Money? targetPrice,
    bool? enabled,
    Alerts? alerts,
  }) {
    final body = {
      'targetPrice': ?targetPrice?.toJson(),
      'enabled': ?enabled,
      'alerts': ?alerts?.toJson(),
    };
    if (body.isEmpty) throw ArgumentError('An editable field is required.');
    return _request(
      'PATCH',
      '/api/tracked-items/${_id(id)}',
      (json) => _ownedItem(json, id),
      body: body,
    );
  }

  Future<void> delete(String id) =>
      _request('DELETE', '/api/tracked-items/${_id(id)}', (_) {}, status: 204);
  Future<History> history(
    String id, {
    String? cursor,
    int limit = 20,
    DateTime? from,
    DateTime? to,
  }) {
    if (from != null &&
        to != null &&
        (!from.isBefore(to) ||
            to.difference(from) > const Duration(days: 90))) {
      throw ArgumentError('History requires from < to within 90 days.');
    }
    return _request(
      'GET',
      '/api/tracked-items/${_id(id)}/history',
      (json) {
        final history = History.fromJson(json);
        if (history.trackedItemId != id) invalidJson();
        return history;
      },
      query: _query(cursor, limit, {
        'from': ?from?.toUtc().toIso8601String(),
        'to': ?to?.toUtc().toIso8601String(),
      }),
    );
  }

  static TrackedItem _ownedItem(Json json, String id) {
    final item = TrackedItem.fromJson(json);
    if (item.id != id) invalidJson();
    return item;
  }

  static String _id(String id) {
    try {
      return jsonId(id);
    } on FormatException {
      throw ArgumentError('Invalid resource ID.');
    }
  }

  static Map<String, String> _query(
    String? cursor,
    int limit,
    Map<String, String> extra,
  ) {
    if (limit < 1 ||
        limit > 100 ||
        (cursor != null && (cursor.isEmpty || cursor.length > 2048))) {
      throw ArgumentError('Invalid pagination.');
    }
    return {'limit': '$limit', 'cursor': ?cursor, ...extra};
  }
}
