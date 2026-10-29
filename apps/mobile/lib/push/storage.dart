import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'events.dart';
import 'validation.dart';

abstract interface class PushStorage implements PushEventStore {
  Future<String> installationId();
}

class PushStorageException implements Exception {
  const PushStorageException();
  @override
  String toString() => 'Local push storage is unavailable or invalid.';
}

/// One foreground isolate only; future background handlers must coordinate with
/// this owner, not race separate secure-storage read/write transactions.
class SecurePushStorage implements PushStorage {
  SecurePushStorage({FlutterSecureStorage? storage})
    : _storage =
          storage ??
          const FlutterSecureStorage(
            aOptions: AndroidOptions(resetOnError: false),
          );

  final FlutterSecureStorage _storage;
  static const installationKey = 'price_tracker.push_installation.v1';
  static const eventsKey = 'price_tracker.push_events.v1';
  // Serialize across instances as well as callers in this isolate.
  static Future<void>? _pending;

  Future<T> _serial<T>(Future<T> Function() action) {
    final previous = _pending;
    final done = Completer<void>();
    _pending = done.future;
    return (() async {
      try {
        if (previous != null) await previous;
        return await action();
      } catch (_) {
        throw const PushStorageException();
      } finally {
        if (identical(_pending, done.future)) _pending = null;
        done.complete();
      }
    })();
  }

  @override
  Future<String> installationId() => _serial(() async {
    final saved = await _storage.read(key: installationKey);
    if (saved != null) {
      if (!isInstallationId(saved)) throw const PushStorageException();
      return saved;
    }
    final random = Random.secure();
    final bytes = List.generate(16, (_) => random.nextInt(256));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final id =
        '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
    await _storage.write(key: installationKey, value: id);
    return id;
  });

  @override
  Future<bool> claim({
    required String sessionId,
    required String eventId,
    required int capacity,
  }) => _serial(() async {
    if (!isPushId(sessionId) ||
        !isPushId(eventId) ||
        capacity < 1 ||
        capacity > 1024) {
      throw const PushStorageException();
    }
    final saved = await _storage.read(key: eventsKey);
    if (saved != null && saved.length > 300000) {
      throw const PushStorageException();
    }
    final data = saved == null ? <dynamic>[] : jsonDecode(saved);
    if (data is! List || data.length > 1024) throw const PushStorageException();
    final keys = <String>[];
    final entries = <List<String>>[];
    for (final pair in data) {
      if (pair is! List ||
          pair.length != 2 ||
          pair.any((id) => id is! String || !isPushId(id))) {
        throw const PushStorageException();
      }
      final entry = pair.cast<String>();
      final key = '${entry[0]}:${entry[1]}';
      if (keys.contains(key)) throw const PushStorageException();
      keys.add(key);
      entries.add(entry);
    }
    final key = '$sessionId:$eventId';
    final exists = keys.contains(key);
    if (!exists) entries.add([sessionId, eventId]);
    final bounded = entries.skip(max(0, entries.length - capacity)).toList();
    if (!exists || bounded.length != entries.length) {
      await _storage.write(key: eventsKey, value: jsonEncode(bounded));
    }
    return !exists;
  });

  @override
  Future<void> clear() => _serial(() => _storage.delete(key: eventsKey));
}
