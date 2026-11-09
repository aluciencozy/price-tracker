import 'dart:async';
import 'dart:io';
import 'dart:isolate';

import 'package:flutter_test/flutter_test.dart';
import 'package:price_tracker/push/atomic_store.dart';
import 'package:price_tracker/push/storage.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'events_test.dart' show payload;

class RecordingPresenter implements PushPresenter {
  int displays = 0, cancellations = 0;
  bool failDisplay = false, failCancel = false;
  Completer<void>? entered, release;
  @override
  Future<void> show(Map<String, Object?> data) async {
    displays++;
    entered?.complete();
    await release?.future;
    if (failDisplay) throw StateError('platform unavailable');
  }

  @override
  Future<void> cancelAll() async {
    cancellations++;
    if (failCancel) throw StateError('platform unavailable');
  }
}

Future<bool> isolatedClaim(String path) async {
  sqfliteFfiInit();
  final db = await databaseFactoryFfi.openDatabase(
    path,
    options: OpenDatabaseOptions(version: 1, singleInstance: false),
  );
  try {
    final store = AtomicPushStorage(
      open: () async => db,
      presenter: RecordingPresenter(),
      installation: () async => 'unused',
      now: () => DateTime.utc(2026, 11, 9),
    );
    return await store.claim(
      sessionId: 'session_example',
      eventId: 'episode_example',
      capacity: 512,
    );
  } finally {
    await db.close();
  }
}

void main() {
  sqfliteFfiInit();
  final now = DateTime.utc(2026, 11, 9);
  late Directory directory;
  late List<Database> connections;
  late RecordingPresenter presenter;
  late AtomicPushStorage foreground, background;
  Future<AtomicPushStorage> connect() async {
    final db = await databaseFactoryFfi.openDatabase(
      '${directory.path}/receipts.db',
      options: OpenDatabaseOptions(
        version: 1,
        singleInstance: false,
        onConfigure: (db) => db.execute('PRAGMA busy_timeout = 5000'),
        onCreate: AtomicPushStorage.create,
      ),
    );
    connections.add(db);
    return AtomicPushStorage(
      open: () async => db,
      presenter: presenter,
      installation: () async => '00000000-0000-4000-8000-000000000000',
      now: () => now,
    );
  }

  Future<bool> claim(
    AtomicPushStorage store, {
    String session = 'session_example',
    String event = 'episode_example',
    int capacity = 512,
  }) => store.claim(sessionId: session, eventId: event, capacity: capacity);
  setUp(() async {
    directory = await Directory.systemTemp.createTemp(
      'price-tracker-push-test-',
    );
    connections = [];
    presenter = RecordingPresenter();
    foreground = await connect();
    background = await connect();
    await foreground.bindSession(
      'session_example',
      now.add(const Duration(days: 1)),
    );
  });
  tearDown(() async {
    for (final db in connections) {
      await db.close();
    }
    await directory.delete(recursive: true);
  });

  test(
    'separate Dart isolates share a unique durable SQLite receipt',
    () async {
      final path = '${directory.path}/receipts.db';
      final results = await Future.wait([
        Isolate.run(() => isolatedClaim(path)),
        Isolate.run(() => isolatedClaim(path)),
      ]);
      expect(results.where((value) => value), hasLength(1));
      expect(await claim(foreground), false);
    },
  );

  test('independent SQLite connections race one durable claim', () async {
    final results = await Future.wait(
      List.generate(2, (i) => claim(i.isEven ? foreground : background)),
    );
    expect(results.where((value) => value), hasLength(1));
  });
  test('same-session restart keeps receipts; varied delivery ID cannot replay episode', () async {
    await background.background(payload());
    final restarted = await connect();
    await restarted.bindSession(
      'session_example',
      now.add(const Duration(days: 1)),
    );
    await restarted.background({
      ...payload(),
      'deliveryId': 'different_delivery',
    });
    expect(presenter.displays, 1);
  });
  test('foreground and background use the same session/episode key', () async {
    await claim(foreground);
    await background.background(payload());
    expect(presenter.displays, 0);
  });
  test('background duplicate arrival displays once', () async {
    await Future.wait([
      foreground.background(payload()),
      background.background(payload()),
    ]);
    expect(presenter.displays, 1);
  });
  test('logout wins before background: no display and no claim', () async {
    await foreground.bindSession(null, null);
    await background.background(payload());
    expect(presenter.displays, 0);
    expect(await claim(background), false);
  });
  test(
    'logout waits for in-flight display then cancels under writer lock',
    () async {
      presenter.entered = Completer<void>();
      presenter.release = Completer<void>();
      final display = background.background(payload());
      await presenter.entered!.future;
      var signedOut = false;
      final logout = foreground
          .bindSession(null, null)
          .then((_) => signedOut = true);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(signedOut, false);
      presenter.release!.complete();
      await Future.wait([display, logout]);
      expect(signedOut, true);
      expect(presenter.cancellations, 2);
      expect(await claim(background, event: 'next_episode'), false);
    },
  );
  test('account switch blocks old event and allows only new session', () async {
    await foreground.bindSession('session_B', now.add(const Duration(days: 1)));
    await background.background(payload());
    await background.background({
      ...payload(),
      'recipientSessionId': 'session_B',
    });
    expect(presenter.displays, 1);
  });
  test('expired bound session cannot display', () async {
    await foreground.bindSession('session_example', now);
    await background.background(payload());
    expect(presenter.displays, 0);
  });
  test('capacity fails closed without evicting old episode keys', () async {
    expect(await claim(foreground, capacity: 1), true);
    await expectLater(
      claim(background, event: 'next_episode', capacity: 1),
      throwsA(isA<PushStorageException>()),
    );
    expect(await claim(background), false);
  });
  test(
    'display failure keeps committed claim (safety over guaranteed display)',
    () async {
      presenter.failDisplay = true;
      await expectLater(background.background(payload()), throwsStateError);
      presenter.failDisplay = false;
      await foreground.background(payload());
      expect(presenter.displays, 1);
    },
  );
  test('cancel failure cannot roll back logout eligibility', () async {
    presenter.failCancel = true;
    await expectLater(
      foreground.bindSession(null, null),
      throwsA(isA<PushStorageException>()),
    );
    await background.background(payload());
    expect(presenter.displays, 0);
  });
  test('tampered fields never claim or present', () async {
    await expectLater(
      background.background({...payload(), 'title': 'private claimed title'}),
      throwsFormatException,
    );
    await expectLater(
      background.background({...payload(), 'recipientSessionId': '../bad'}),
      throwsFormatException,
    );
    expect(presenter.displays, 0);
    expect(await claim(foreground), true);
  });
  test('unknown recipient never claims or presents', () async {
    await background.background({
      ...payload(),
      'recipientSessionId': 'foreign_session',
    });
    expect(presenter.displays, 0);
    expect(await claim(foreground), true);
  });
}
