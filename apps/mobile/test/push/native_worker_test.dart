import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:price_tracker/push/atomic_store.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
// Pinned FFI test internals let us model Android's one process-wide native
// worker, instead of independent FFI worker threads hiding its head-of-line wait.
// ignore: depend_on_referenced_packages, implementation_imports
import 'package:sqflite_common/src/mixin/factory.dart';
// ignore: implementation_imports
import 'package:sqflite_common_ffi/src/database_factory_ffi_io.dart';
// ignore: implementation_imports
import 'package:sqflite_common_ffi/src/method_call.dart';

import 'atomic_store_test.dart' show RecordingPresenter;
import 'events_test.dart' show payload;

/// Real SQLite connections behind one FIFO method worker. Android's default
/// busy timeout holds that worker inside sqlite3, also blocking the owner's
/// queued COMMIT. FFI reports BUSY immediately, so model that native wait here.
class AndroidWorkerModel {
  Future<void> _tail = Future<void>.value();
  final failFastConnections = <int>{};
  final contended = Completer<void>();
  int busyAttempts = 0, nativeWaits = 0;

  Future<Object?> invoke(String method, [Object? arguments]) {
    final result = _tail.then((_) async {
      final args = arguments is Map ? arguments : const {};
      final id = args['id'];
      try {
        final result = await ffiMethodCallHandleNoIsolate(
          FfiMethodCall(method, arguments),
        );
        if (args['sql'] == 'PRAGMA busy_timeout = 0' && id is int) {
          failFastConnections.add(id);
        }
        return result;
      } on DatabaseException catch (error) {
        if (error.getResultCode() == 5) {
          busyAttempts++;
          if (!contended.isCompleted) contended.complete();
          if (!failFastConnections.contains(id)) {
            nativeWaits++;
            await Future<void>.delayed(const Duration(milliseconds: 2500));
          }
        }
        rethrow;
      }
    });
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }
}

void main() {
  sqfliteFfiInit();
  test('Android single-worker contention yields to COMMIT and logout deactivates durably', () async {
    final worker = AndroidWorkerModel();
    final factory = buildDatabaseFactory(invokeMethod: worker.invoke);
    final directory = await Directory.systemTemp.createTemp(
      'push-native-worker-test-',
    );
    final connections = <Database>[];
    final presenter = RecordingPresenter();
    final now = DateTime.utc(2026, 11, 9);
    Future<AtomicPushStorage> connect() async {
      final db = await factory.openDatabase(
        '${directory.path}/receipts.db',
        options: OpenDatabaseOptions(
          version: 1,
          singleInstance: false,
          onConfigure: AtomicPushStorage.configure,
          onCreate: AtomicPushStorage.create,
        ),
      );
      connections.add(db);
      return AtomicPushStorage(
        open: () async => db,
        presenter: presenter,
        installation: () async => 'unused',
        now: () => now,
      );
    }

    try {
      final foreground = await connect();
      final background = await connect();
      await foreground.bindSession(
        'session_example',
        now.add(const Duration(days: 1)),
      );
      presenter.entered = Completer<void>();
      presenter.release = Completer<void>();
      final display = background.background(payload());
      await presenter.entered!.future;
      Object? logoutFailure;
      final logout = foreground.bindSession(null, null).catchError((
        Object error,
      ) {
        logoutFailure = error;
      });
      // Release only after B's BEGIN has hit A's real SQLite writer lock. The
      // owner's COMMIT then needs the very same worker B must not monopolize.
      await worker.contended.future;
      presenter.release!.complete();
      await Future.wait([display, logout]);
      expect(logoutFailure, isNull);
      expect(worker.busyAttempts, greaterThan(0));
      expect(worker.nativeWaits, 0);
      expect(worker.failFastConnections, hasLength(2));
      expect(presenter.displays, 1);
      expect(presenter.cancellations, 2);
      expect(
        await background.claim(
          sessionId: 'session_example',
          eventId: 'later_episode',
          capacity: 512,
        ),
        false,
      );
      final restarted = await connect();
      expect(
        await restarted.claim(
          sessionId: 'session_example',
          eventId: 'restart_episode',
          capacity: 512,
        ),
        false,
      );
    } finally {
      for (final db in connections) {
        await db.close();
      }
      await directory.delete(recursive: true);
    }
  });
}
