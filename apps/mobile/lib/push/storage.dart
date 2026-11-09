import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'events.dart';
import 'validation.dart';

abstract interface class PushStorage implements PushEventStore {
  Future<String> installationId();
}

class DeviceBindingMetadata {
  const DeviceBindingMetadata(this.sessionId, this.deviceId, this.pending);
  final String sessionId;
  final String? deviceId;
  final bool pending;
}

abstract interface class DeviceBindingStore {
  Future<DeviceBindingMetadata?> read(String sessionId);
  Future<void> write(DeviceBindingMetadata metadata);
  Future<void> clear(String sessionId);
}

/// Metadata only: neither bearer credentials nor FCM tokens are stored here.
class SecureDeviceBindingStore implements DeviceBindingStore {
  SecureDeviceBindingStore(this.origin, {FlutterSecureStorage? storage})
    : _storage =
          storage ??
          const FlutterSecureStorage(
            aOptions: AndroidOptions(resetOnError: false),
          );
  final String origin;
  final FlutterSecureStorage _storage;
  static const key = 'price_tracker.push_device_binding.v1';

  @override
  Future<DeviceBindingMetadata?> read(String sessionId) async {
    final raw = await _storage.read(key: key);
    if (raw == null) return null;
    final data = jsonDecode(raw);
    if (data is! Map ||
        data['origin'] is! String ||
        data['session'] is! String ||
        !isPushId(data['session'] as String) ||
        data['pending'] is! bool ||
        (data['device'] != null &&
            (data['device'] is! String ||
                !isPushId(data['device'] as String)))) {
      throw const PushStorageException();
    }
    if (data['origin'] != origin || data['session'] != sessionId) return null;
    return DeviceBindingMetadata(
      sessionId,
      data['device'] as String?,
      data['pending'] as bool,
    );
  }

  @override
  Future<void> write(DeviceBindingMetadata metadata) async {
    if (!isPushId(metadata.sessionId) ||
        (metadata.deviceId != null && !isPushId(metadata.deviceId!))) {
      throw const PushStorageException();
    }
    await _storage.write(
      key: key,
      value: jsonEncode({
        'origin': origin,
        'session': metadata.sessionId,
        'device': metadata.deviceId,
        'pending': metadata.pending,
      }),
    );
  }

  @override
  Future<void> clear(String sessionId) async {
    if (await read(sessionId) != null) await _storage.delete(key: key);
  }
}

class PushStorageException implements Exception {
  const PushStorageException();
  @override
  String toString() => 'Local push storage is unavailable or invalid.';
}

/// Legacy foreground-only receipt store and secure installation UUID provider.
/// Real FCM uses AtomicPushStorage for receipts, never these isolate-local claims.
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
