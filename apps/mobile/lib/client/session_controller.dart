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
  String? _sessionId;
  Timer? _expiry;
  Future<void>? _clearing;
  bool _busy = false;
  User? get user => _user;
  String? get sessionId => _sessionId;
  // Only automatic expiry errors use this property; explicit actions throw.
  ApiFailure? expiryFailure;

  Future<void> restore() => _exclusive(() async {
    String? saved;
    try {
      saved = await store.read();
    } catch (_) {
      throw const ApiFailure('STORAGE', 'Could not read the secure session.');
    }
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
    api.setSession(session);
    try {
      final user = await api.me();
      if (user.id != session.user.id) {
        await _clear();
        throw const ApiFailure('INVALID_SESSION', 'Please sign in again.');
      }
      _accept(session, user);
    } catch (_) {
      // Network failure retains the secure record for a retry, but startup
      // does not authorize private screens until /me succeeds. A 401 clears it.
      _dropMemory();
      rethrow;
    }
  });

  Future<void> login(String email, String password) => _exclusive(() async {
    if (_user != null) {
      throw const ApiFailure(
        'ALREADY_SIGNED_IN',
        'Sign out before switching accounts.',
      );
    }
    final session = await api.login(email, password);
    try {
      await store.write(jsonEncode(session.toJson()));
    } catch (_) {
      await _clear();
      throw const ApiFailure('STORAGE', 'Could not save the secure session.');
    }
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
    await Future.wait([api.logout(), _clear()]);
  });

  void _accept(Session session, User user) {
    _user = user;
    _sessionId = session.sessionId;
    expiryFailure = null;
    _expiry?.cancel();
    _expiry = Timer(session.expiresAt.difference(_now()), () async {
      try {
        await _clear();
      } on ApiFailure catch (error) {
        expiryFailure = error;
        notifyListeners();
      }
    });
    notifyListeners();
  }

  void _dropMemory() {
    _expiry?.cancel();
    api.setSession(null);
    _user = null;
    _sessionId = null;
    notifyListeners();
  }

  Future<void> _clear() => _clearing ??= _clearStored().whenComplete(() {
    _clearing = null;
  });
  Future<void> _clearStored() async {
    _dropMemory();
    try {
      await store.clear();
    } catch (_) {
      throw const ApiFailure(
        'STORAGE',
        'Signed out in memory, but secure storage could not be cleared. Retry sign out.',
      );
    }
  }

  Future<void> _exclusive(Future<void> Function() action) async {
    if (_busy) {
      throw const ApiFailure('BUSY', 'An account request is in progress.');
    }
    _busy = true;
    try {
      final clearing = _clearing;
      if (clearing != null) await clearing;
      await action();
    } finally {
      _busy = false;
    }
  }

  @override
  void dispose() {
    _expiry?.cancel();
    api.onUnauthorized = null;
    api.setSession(null);
    super.dispose();
  }
}
