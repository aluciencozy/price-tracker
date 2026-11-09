import 'package:sqflite/sqflite.dart';

import 'events.dart';
import 'storage.dart';
import 'validation.dart';

abstract interface class PushPresenter {
  Future<void> show(Map<String, Object?> data);
  Future<void> cancelAll();
}

abstract interface class PushSessionStorage {
  Future<void> bindSession(String? id, DateTime? expiresAt);
}

/// Shared SQLite transactions, not isolate-local compare-then-write. No JWTs or
/// game content. Reaching capacity fails closed; live receipts are never evicted.
class AtomicPushStorage implements PushStorage, PushSessionStorage {
  AtomicPushStorage({
    required this.open,
    required this.presenter,
    required this.installation,
    DateTime Function()? now,
  }) : now = now ?? DateTime.now;
  final Future<Database> Function() open;
  final PushPresenter presenter;
  final Future<String> Function() installation;
  final DateTime Function() now;

  Future<T> _transaction<T>(
    Database db,
    Future<T> Function(Transaction) action,
  ) async {
    final clock = Stopwatch()..start();
    while (true) {
      var entered = false;
      try {
        return await db.transaction((tx) {
          entered = true;
          return action(tx);
        });
      } on DatabaseException catch (error) {
        final code = error.getResultCode();
        // Separate engines/connections may report SQLITE_BUSY at BEGIN rather
        // than queue. Retry only lock acquisition, never a transaction body or
        // an uncertain notification side effect/COMMIT.
        if (entered ||
            ![5, 6].contains(code == null ? null : code & 255) ||
            clock.elapsed >= const Duration(seconds: 2)) {
          rethrow;
        }
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
    }
  }

  static Future<Database>? _androidDatabase;
  static Future<Database> openAndroid() =>
      _androidDatabase ??= _openAndroid().catchError((Object error) {
        _androidDatabase = null;
        throw error;
      });
  static Future<Database> _openAndroid() async => openDatabase(
    '${await getDatabasesPath()}/price_tracker_push_v1.db',
    version: 1,
    // Cache ONE handle in each isolate, but never reuse a native handle across
    // engines. sqflite's single-instance recovery may otherwise ROLLBACK a live
    // transaction owned by the other isolate as if it were a hot restart.
    singleInstance: false,
    onConfigure: configure,
    onCreate: create,
  );
  static Future<void> configure(Database db) async {
    // Android's process-wide sqflite worker must not wait inside SQLite while
    // another connection's COMMIT is queued behind it. Fail BEGIN fast so the
    // bounded Dart retry above yields the worker to the lock owner instead.
    // This PRAGMA returns a row: use rawQuery, not Android's execSQL path.
    await db.rawQuery('PRAGMA busy_timeout = 0');
  }

  static Future<void> create(Database db, int version) async {
    await db.execute(
      'CREATE TABLE session (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)',
    );
    await db.execute(
      'CREATE TABLE receipts (session TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(session,event))',
    );
  }

  Future<bool> _eligible(Transaction tx, String id) async =>
      (await tx.query(
        'session',
        where: 'id = ? AND expires > ?',
        whereArgs: [id, now().millisecondsSinceEpoch],
      )).length ==
      1;
  @override
  Future<String> installationId() => installation();
  @override
  Future<void> bindSession(String? id, DateTime? expiresAt) async {
    if (id != null && (!isPushId(id) || expiresAt == null)) {
      throw const PushStorageException();
    }
    final db = await open();
    var cancellationFailed = false;
    await _transaction(db, (tx) async {
      final old = await tx.query('session');
      if (old.length != 1 || old.single['id'] != id) {
        await tx.delete('session');
        await tx.delete('receipts');
        // Same writer lock as presentation: logout follows and cancels a
        // completed generic display, or wins first and blocks the display.
        try {
          await presenter.cancelAll();
        } catch (_) {
          cancellationFailed = true;
        }
      }
      if (id != null) {
        await tx.insert('session', {
          'id': id,
          'expires': expiresAt!.millisecondsSinceEpoch,
        }, conflictAlgorithm: ConflictAlgorithm.replace);
      }
    });
    if (cancellationFailed) throw const PushStorageException();
  }

  @override
  Future<bool> claim({
    required String sessionId,
    required String eventId,
    required int capacity,
  }) async {
    if (!isPushId(sessionId) ||
        !isPushId(eventId) ||
        capacity < 1 ||
        capacity > 1024) {
      throw const PushStorageException();
    }
    final db = await open();
    return _transaction(db, (tx) async {
      if (!await _eligible(tx, sessionId)) return false;
      if ((await tx.query(
        'receipts',
        where: 'session = ? AND event = ?',
        whereArgs: [sessionId, eventId],
      )).isNotEmpty) {
        return false;
      }
      final count = Sqflite.firstIntValue(
        await tx.rawQuery('SELECT COUNT(*) FROM receipts'),
      )!;
      if (count >= capacity) throw const PushStorageException();
      await tx.insert('receipts', {'session': sessionId, 'event': eventId});
      return true;
    });
  }

  Future<void> background(Map<String, Object?> data) async {
    final event = PushEvent.parse(data);
    if (!await claim(
      sessionId: event.recipientSessionId,
      eventId: event.eventId,
      capacity: 512,
    )) {
      return;
    }
    // Commit BEFORE display: process death may lose a display, never retry it.
    final db = await open();
    await _transaction(db, (tx) async {
      if (await _eligible(tx, event.recipientSessionId)) {
        await presenter.show(data);
      }
    });
  }

  @override
  Future<void> clear() async {
    final db = await open();
    await _transaction(db, (tx) async {
      await tx.delete('receipts');
      await presenter.cancelAll();
    });
  }
}
