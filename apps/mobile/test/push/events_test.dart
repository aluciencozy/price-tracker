import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:price_tracker/push/device_api.dart';
import 'package:price_tracker/push/events.dart';

Map<String, Object?> payload() => {
  'schemaVersion': '1',
  'type': 'price_target_reached',
  'eventId': 'episode_example',
  'deliveryId': 'delivery_push_example',
  'recipientSessionId': 'session_example',
  'trackedItemId': 'tracker_example',
  'productId': 'product_1',
  'observedAt': '2026-10-26T16:34:42.829Z',
};

// Test fixture only. This is not durable production storage.
class TestStore implements PushEventStore {
  final keys = <String>[];
  bool fail = false;
  Completer<void>? gate;
  @override
  Future<bool> claim({
    required String sessionId,
    required String eventId,
    required int capacity,
  }) async {
    if (gate != null) await gate!.future;
    if (fail) throw StateError('storage unavailable');
    final key = '$sessionId:$eventId';
    if (keys.contains(key)) return false;
    keys.add(key);
    while (keys.length > capacity) {
      keys.removeAt(0);
    }
    return true;
  }

  @override
  Future<void> clear() async => keys.clear();
}

void main() {
  test('reads the actual contract example; fields are immutable snapshots', () {
    final raw = payload();
    final event = PushEvent.parse(raw);
    raw['trackedItemId'] = 'changed';
    expect(event.eventId, 'episode_example');
    expect(event.deliveryId, 'delivery_push_example');
    expect(event.trackedItemId, 'tracker_example');
    expect(event.productId, 'product_1');
    expect(event.recipientSessionId, 'session_example');
    expect(event.observedAt, DateTime.utc(2026, 10, 26, 16, 34, 42, 829));
    expect(
      PushEvent.parse({...payload(), 'eventId': '_opaque-id'}).eventId,
      '_opaque-id',
    );
  });

  test('strictly rejects missing, nonstring, extra and old-draft fields', () {
    for (final key in payload().keys) {
      expect(
        () => PushEvent.parse(payload()..remove(key)),
        throwsFormatException,
        reason: key,
      );
      expect(
        () => PushEvent.parse({...payload(), key: 1}),
        throwsFormatException,
        reason: key,
      );
    }
    for (final key in [
      'title',
      'priceMinor',
      'targetMinor',
      'currency',
      'sourceName',
      'purchaseUrl',
      'ownerId',
    ]) {
      expect(
        () => PushEvent.parse({...payload(), key: 'untrusted'}),
        throwsFormatException,
        reason: key,
      );
    }
  });

  for (final entry in {
    'schemaVersion': ['2', 1],
    'type': ['price_alert', 'other'],
    'eventId': ['', '../id', 'id\n', 'a' * 129],
    'deliveryId': ['a/b'],
    'recipientSessionId': ['with space'],
    'trackedItemId': ['id?x'],
    'productId': ['id#x'],
    'observedAt': [
      '2026-02-30T12:00:00Z',
      '2026-13-01T12:00:00Z',
      '2026-10-28',
      '2026-10-28T12:00:00+00:00',
      '2026-10-28T25:00:00Z',
      '2026-10-28T12:00:00Z\n',
    ],
  }.entries) {
    test('rejects invalid ${entry.key}', () {
      for (final value in entry.value) {
        expect(
          () => PushEvent.parse({...payload(), entry.key: value}),
          throwsFormatException,
          reason: '$value',
        );
      }
    });
  }

  group('event boundary', () {
    late PushSession? session;
    late TestStore store;
    late List<PushEvent> accepted;
    late List<AuthorizedPushTracker> opened;
    late List<String> reads;
    late Future<AuthorizedPushTracker?> Function(PushSession, String) reader;
    late PushEvents events;
    const tracker = AuthorizedPushTracker(
      id: 'tracker_example',
      productId: 'product_1',
    );
    PushEvents build({int capacity = 512}) => PushEvents(
      readSession: () => session,
      store: store,
      onForeground: accepted.add,
      readOwnedTracker: (owner, id) => reader(owner, id),
      openTracker: opened.add,
      capacity: capacity,
    );
    setUp(() {
      session = PushSession(
        id: 'session_example',
        bearerToken: 'fixture-bearer',
      );
      store = TestStore();
      accepted = [];
      opened = [];
      reads = [];
      reader = (owner, id) async {
        reads.add('${owner.id}:$id');
        return tracker;
      };
      events = build();
    });

    test('invalid and wrong-session events never reach storage, UI or owned reader', () async {
      expect(await events.foreground({}), ForegroundPushResult.invalid);
      expect(await events.tap({}), PushTapResult.invalid);
      for (final current in [
        null,
        PushSession(id: 'other-session', bearerToken: 'other-bearer'),
      ]) {
        session = current;
        expect(
          await events.foreground(payload()),
          ForegroundPushResult.wrongSession,
        );
        expect(await events.tap(payload()), PushTapResult.wrongSession);
      }
      expect(store.keys, isEmpty);
      expect(accepted, isEmpty);
      expect(opened, isEmpty);
      expect(reads, isEmpty);
    });

    test(
      'stable event ID dedupes overlap and a reconstructed handler',
      () async {
        final results = await Future.wait([
          events.foreground(payload()),
          build().foreground({...payload(), 'deliveryId': 'other-delivery'}),
        ]);
        expect(results, [
          ForegroundPushResult.accepted,
          ForegroundPushResult.duplicate,
        ]);
        expect(accepted.length, 1);
        expect(
          await build().foreground(payload()),
          ForegroundPushResult.duplicate,
        );
      },
    );

    test(
      'bounded eviction permits old replay; new episode can be accepted',
      () async {
        events = build(capacity: 1);
        expect(
          await events.foreground(payload()),
          ForegroundPushResult.accepted,
        );
        expect(
          await events.foreground({...payload(), 'eventId': 'episode-b'}),
          ForegroundPushResult.accepted,
        );
        expect(store.keys.length, 1);
        expect(
          await events.foreground(payload()),
          ForegroundPushResult.accepted,
        );
        expect(() => build(capacity: 0), throwsArgumentError);
        expect(() => build(capacity: 1025), throwsArgumentError);
      },
    );

    test(
      'keys are session-scoped; clearing fixture loses dedupe as documented',
      () async {
        await events.foreground(payload());
        session = PushSession(id: 'session-b', bearerToken: 'other-bearer');
        expect(
          await events.foreground({
            ...payload(),
            'recipientSessionId': 'session-b',
          }),
          ForegroundPushResult.accepted,
        );
        expect(store.keys.length, 2);
        await store.clear();
        expect(
          await events.foreground({
            ...payload(),
            'recipientSessionId': 'session-b',
          }),
          ForegroundPushResult.accepted,
        );
      },
    );

    test(
      'storage failure fails closed, not an unguarded UI callback',
      () async {
        store.fail = true;
        expect(
          await events.foreground(payload()),
          ForegroundPushResult.storageUnavailable,
        );
        expect(accepted, isEmpty);
      },
    );

    test('logout during awaited storage cannot expose event to UI', () async {
      store.gate = Completer<void>();
      final result = events.foreground(payload());
      session = null;
      store.gate!.complete();
      expect(await result, ForegroundPushResult.wrongSession);
      expect(accepted, isEmpty);
    });

    test(
      'tap always reads owned tracker, even after foreground acceptance',
      () async {
        await events.foreground(payload());
        expect(await events.tap(payload()), PushTapResult.opened);
        expect(reads, ['session_example:tracker_example']);
        expect(opened, [tracker]);
      },
    );

    test(
      'deleted/foreign 404 and expired or offline auth never navigate',
      () async {
        reader = (_, _) async => null;
        expect(await events.tap(payload()), PushTapResult.notFound);
        reader = (_, _) async => throw const PushSessionExpired();
        expect(await events.tap(payload()), PushTapResult.sessionExpired);
        reader = (_, _) async => throw StateError('offline');
        expect(await events.tap(payload()), PushTapResult.unavailable);
        expect(opened, isEmpty);
      },
    );

    test('account switch during owned read cannot navigate', () async {
      final result = Completer<AuthorizedPushTracker?>();
      reader = (_, _) => result.future;
      final tap = events.tap(payload());
      session = PushSession(id: 'session-b', bearerToken: 'other-bearer');
      result.complete(tracker);
      expect(await tap, PushTapResult.wrongSession);
      expect(opened, isEmpty);
    });

    test(
      'mismatched authorized tracker/product cannot route from payload',
      () async {
        for (final result in [
          const AuthorizedPushTracker(
            id: 'other-tracker',
            productId: 'product_1',
          ),
          const AuthorizedPushTracker(
            id: 'tracker_example',
            productId: 'other-product',
          ),
        ]) {
          reader = (_, _) async => result;
          expect(await events.tap(payload()), PushTapResult.invalid);
        }
        expect(opened, isEmpty);
      },
    );

    test('claim-before-callback is not exactly-once display', () async {
      final brokenUI = PushEvents(
        readSession: () => session,
        store: store,
        onForeground: (_) => throw StateError('UI failed'),
        readOwnedTracker: reader,
        openTracker: opened.add,
      );
      await expectLater(brokenUI.foreground(payload()), throwsStateError);
      expect(
        await events.foreground(payload()),
        ForegroundPushResult.duplicate,
      );
      expect(accepted, isEmpty);
    });
  });
}
