import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'mobile_api.dart';
import 'models.dart';
import 'session_store.dart';

/// UI must discard private routes/caches whenever user becomes null.
class SessionController extends ChangeNotifier {
  SessionController({
    required this.api,
    required this.store,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now {
    api.onUnauthorized = _clear;
  }
  final MobileApi api;
  final SessionStore store;
  final DateTime Function() _now;
  User? _user;
  Session? _credentials;
  String? _sessionId;
  Timer? _expiry;
  Future<void>? _clearing;
  bool _busy = false;
  bool _disposed = false;
  bool _revocationUnconfirmed = false;
  bool _cleanupRequired = false;
  bool get cleanupRequired => _cleanupRequired;
  bool get revocationUnconfirmed => _revocationUnconfirmed;
  User? get user => _user;
  String? get sessionId => _sessionId;
  // Only automatic expiry errors use this property; explicit actions throw.
  ApiFailure? _expiryFailure;
  ApiFailure? get expiryFailure => _expiryFailure;

  Future<void> restore() => _exclusive(() async {
    if (_user != null) return;
    String? saved;
    try {
      saved = await store.read();
    } catch (_) {
      throw const ApiFailure('STORAGE', 'Could not read the secure session.');
    }
    if (_disposed) return;
    if (saved == null) return;
    Session session;
    try {
      session = Session.fromJson(jsonObject(jsonDecode(saved)));
    } on FormatException {
      await _clear();
      throw const ApiFailure('INVALID_SESSION', 'Please sign in again.');
    }
    if (session.expired(_now())) {
      await _clear();
      throw const ApiFailure('SESSION_EXPIRED', 'Please sign in again.');
    }
    _credentials = session;
    api.setSession(session);
    try {
      final user = await api.me();
      if (_disposed) return;
      if (user.id != session.user.id) {
        await _clear();
        throw const ApiFailure('INVALID_SESSION', 'Please sign in again.');
      }
      _accept(session, user);
    } catch (_) {
      // Network failure retains the secure record for a retry, but startup
      // does not authorize private screens until /me succeeds. A 401 clears it.
      if (_disposed) return;
      _dropMemory(keepCredentials: true);
      rethrow;
    }
  });

  Future<void> login(String email, String password) => _exclusive(() async {
    if (_cleanupRequired) {
      throw const ApiFailure(
        'STORAGE',
        'Clear the previous local credentials before signing in.',
      );
    }
    if (_credentials != null) {
      throw const ApiFailure(
        'ALREADY_SIGNED_IN',
        'Sign out before switching accounts.',
      );
    }
    final session = await api.login(email, password);
    if (_disposed) return;
    try {
      await store.write(jsonEncode(session.toJson()));
    } catch (_) {
      if (_disposed) return;
      await _clear();
      throw const ApiFailure('STORAGE', 'Could not save the secure session.');
    }
    if (_disposed) return;
    // Secure storage itself can take long enough for a token to expire.
    if (session.expired(_now())) {
      await _clear();
      throw const ApiFailure('SESSION_EXPIRED', 'Please sign in again.');
    }
    api.setSession(session);
    _accept(session, session.user);
  });

  Future<void> logout() => _exclusive(() async {
    // Capture the token for revocation, then clear disk and memory immediately.
    // Offline revocation still fails honestly after local sign-out completes.
    // Startup may have retained a validated credential after an offline /me.
    // It may revoke that session, but never authorizes private screens itself.
    if (_credentials == null) {
      await _clear();
      return;
    }
    api.setSession(_credentials);
    Future<void> revoke() async {
      try {
        await api.logout();
        _revocationUnconfirmed = false;
      } catch (_) {
        _revocationUnconfirmed = true;
        rethrow;
      }
    }

    await Future.wait([revoke(), _clear()]);
  });

  Future<void> checkSession() async {
    if (_disposed || _busy || _user == null) return;
    final credentials = _credentials;
    // A read-only resume check must not block sign-out. MobileApi rejects old
    // transport generations; this identity guard also discards stale errors.
    try {
      final user = await api.me();
      if (_disposed || !identical(credentials, _credentials)) return;
      if (user.id != _user?.id) {
        await _clear();
        throw const ApiFailure('INVALID_SESSION', 'Please sign in again.');
      }
      _user = user;
      _notify();
    } catch (error) {
      if (_disposed || !identical(credentials, _credentials)) {
        // Failed secure deletion still needs an explicit cleanup error.
        if (error is ApiFailure &&
            error.code == 'STORAGE' &&
            _cleanupRequired) {
          rethrow;
        }
        return;
      }
      rethrow;
    }
  }

  void _accept(Session session, User user) {
    if (_disposed) return;
    _user = user;
    _credentials = session;
    _sessionId = session.sessionId;
    _expiryFailure = null;
    _expiry?.cancel();
    _expiry = Timer(session.expiresAt.difference(_now()), () async {
      _expiryFailure = const ApiFailure(
        'SESSION_EXPIRED',
        'Please sign in again.',
      );
      try {
        await _clear();
      } on ApiFailure catch (error) {
        _expiryFailure = error;
        _notify();
      }
    });
    _notify();
  }

  void _dropMemory({bool keepCredentials = false}) {
    _expiry?.cancel();
    api.setSession(null);
    _user = null;
    _sessionId = null;
    if (!keepCredentials) _credentials = null;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> _clear() {
    final pending = _clearing;
    if (pending != null) return pending;
    final completion = Completer<void>();
    // Register deletion before notifying listeners: a reentrant login must wait
    // for this old account's secure record to be removed before writing its own.
    _clearing = completion.future;
    () async {
      try {
        await _clearStored();
        completion.complete();
      } catch (error, stack) {
        completion.completeError(error, stack);
      } finally {
        _clearing = null;
      }
    }();
    return completion.future;
  }

  Future<void> _clearStored() async {
    _cleanupRequired = true;
    _dropMemory();
    try {
      await store.clear();
      _cleanupRequired = false;
      _notify();
    } catch (_) {
      throw const ApiFailure(
        'STORAGE',
        'Signed out in memory, but secure storage could not be cleared. Retry sign out.',
      );
    }
  }

  Future<void> _exclusive(Future<void> Function() action) async {
    if (_disposed) throw StateError('SessionController is disposed.');
    if (_busy) {
      throw const ApiFailure('BUSY', 'An account request is in progress.');
    }
    _busy = true;
    try {
      final clearing = _clearing;
      if (clearing != null) await clearing;
      if (_disposed) return;
      await action();
    } finally {
      _busy = false;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _expiry?.cancel();
    api.onUnauthorized = null;
    api.setSession(null);
    super.dispose();
  }
}
