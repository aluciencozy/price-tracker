import 'device_api.dart';

enum PushPermission { unconfigured, denied, granted }

abstract interface class PushPermissionGateway {
  Future<PushPermission> permission({required bool request});
  Future<String?> token();
}

class UnconfiguredPushGateway implements PushPermissionGateway {
  const UnconfiguredPushGateway();

  @override
  Future<PushPermission> permission({required bool request}) async =>
      PushPermission.unconfigured;

  @override
  Future<String?> token() async => null;
}

enum PushStatus {
  unconfigured,
  signedOut,
  denied,
  noToken,
  offline,
  registered,
  error,
}

enum PushRevocation { notNeeded, confirmed, unconfirmed }

/// Call after session changes, token rotation, or an explicit retry. Saving a
/// tracker preference deliberately has no connection to device registration.
class PushRegistration {
  PushRegistration({
    required this.devices,
    required this.readSession,
    this.gateway = const UnconfiguredPushGateway(),
  });

  final DeviceEndpoint devices;
  final PushSession? Function() readSession;
  final PushPermissionGateway gateway;

  PushStatus get status => _status;
  PushRevocation get revocation => _revocation;
  int? get retryAfterSeconds => _retryAfterSeconds;

  PushStatus _status = PushStatus.unconfigured;
  PushRevocation _revocation = PushRevocation.notNeeded;
  int? _retryAfterSeconds;
  bool _hasUnconfirmedRevocation = false;
  String? _contextSessionId;
  _Binding? _binding;
  Future<void> _pending = Future<void>.value();

  Future<void> synchronize({bool requestPermission = false}) {
    final session = readSession();
    _Binding? old;
    if (session?.id != _contextSessionId) {
      _contextSessionId = session?.id;
      old = _binding;
      _binding = null;
      _retryAfterSeconds = null;
      _status = session == null
          ? PushStatus.signedOut
          : PushStatus.unconfigured;
      if (old != null) _revocation = PushRevocation.unconfirmed;
    }
    final cleanup = old;
    _pending = _pending.then((_) async {
      if (cleanup != null) await _remove(cleanup);
      if (_isCurrent(session)) await _synchronize(session, requestPermission);
    });
    return _pending;
  }

  bool _isCurrent(PushSession? session) => readSession()?.id == session?.id;

  Future<void> _synchronize(PushSession? session, bool request) async {
    if (session == null) {
      _status = PushStatus.signedOut;
      return;
    }
    var writeAttempted = false;
    try {
      final permission = await gateway.permission(request: request);
      if (!_isCurrent(session)) return;
      if (permission != PushPermission.granted) {
        await _clearBinding();
        if (_isCurrent(session)) {
          _status = permission == PushPermission.denied
              ? PushStatus.denied
              : PushStatus.unconfigured;
        }
        return;
      }
      final token = await gateway.token();
      if (!_isCurrent(session)) return;
      if (token == null || token.isEmpty) {
        await _clearBinding();
        if (_isCurrent(session)) _status = PushStatus.noToken;
        return;
      }
      final previous = _binding;
      if (previous?.token == token) {
        _retryAfterSeconds = null;
        _status = PushStatus.registered;
        return;
      }
      writeAttempted = true;
      final device = previous == null
          ? await devices.register(session, token)
          : await devices.update(session, previous.device.id, token);
      final binding = _Binding(session, device, token);
      if (!_isCurrent(session)) {
        // A queued session change already owns cleanup of an existing device.
        if (previous == null || identical(_binding, previous)) {
          _binding = null;
          await _remove(binding);
        }
        return;
      }
      _binding = binding;
      _retryAfterSeconds = null;
      _status = PushStatus.registered;
    } on DeviceApiException catch (error) {
      if (writeAttempted &&
          [
            DeviceFailure.offline,
            DeviceFailure.invalidResponse,
          ].contains(error.reason)) {
        // A lost response may conceal an accepted registration without its ID.
        _hasUnconfirmedRevocation = true;
        _revocation = PushRevocation.unconfirmed;
      }
      if (_isCurrent(session)) {
        _retryAfterSeconds = error.retryAfterSeconds;
        _status = error.reason == DeviceFailure.offline
            ? PushStatus.offline
            : PushStatus.error;
      }
    } catch (_) {
      if (writeAttempted) {
        _hasUnconfirmedRevocation = true;
        _revocation = PushRevocation.unconfirmed;
      }
      if (_isCurrent(session)) _status = PushStatus.error;
    }
  }

  Future<void> _clearBinding() async {
    final binding = _binding;
    _binding = null;
    if (binding != null) await _remove(binding);
  }

  Future<void> _remove(_Binding binding) async {
    _revocation = PushRevocation.unconfirmed;
    try {
      await devices.unregister(binding.session, binding.device.id);
      _revocation = _hasUnconfirmedRevocation
          ? PushRevocation.unconfirmed
          : PushRevocation.confirmed;
    } catch (_) {
      // Local context is cleared even when remote revocation is uncertain.
      _hasUnconfirmedRevocation = true;
      _revocation = PushRevocation.unconfirmed;
    }
  }
}

class _Binding {
  const _Binding(this.session, this.device, this.token);
  final PushSession session;
  final PushDevice device;
  final String token;
}
