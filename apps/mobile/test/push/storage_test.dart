import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:price_tracker/push/storage.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const platform = FlutterSecureStorage();
  setUp(() => FlutterSecureStorage.setMockInitialValues({'unrelated': 'keep'}));

  test(
    'installation UUID persists across instances and event-key deletion',
    () async {
      final store = SecurePushStorage();
      final ids = await Future.wait([
        store.installationId(),
        SecurePushStorage().installationId(),
      ]);
      expect(ids[0], ids[1]);
      expect(
        ids[0],
        matches(
          RegExp(
            r'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',
          ),
        ),
      );
      await store.claim(
        sessionId: 'session-a',
        eventId: 'event-a',
        capacity: 2,
      );
      await store.clear();
      expect(await SecurePushStorage().installationId(), ids[0]);
      expect(await platform.read(key: SecurePushStorage.eventsKey), isNull);
      expect(await platform.read(key: 'unrelated'), 'keep');
    },
  );

  test('durable keys dedupe across instances and concurrent claims', () async {
    final results = await Future.wait([
      SecurePushStorage().claim(
        sessionId: 'session-a',
        eventId: 'episode-a',
        capacity: 2,
      ),
      SecurePushStorage().claim(
        sessionId: 'session-a',
        eventId: 'episode-a',
        capacity: 2,
      ),
    ]);
    expect(results, [true, false]);
    expect(
      await SecurePushStorage().claim(
        sessionId: 'session-b',
        eventId: 'episode-a',
        capacity: 2,
      ),
      isTrue,
    );
    expect(
      jsonDecode((await platform.read(key: SecurePushStorage.eventsKey))!),
      [
        ['session-a', 'episode-a'],
        ['session-b', 'episode-a'],
      ],
    );
    expect(
      await SecurePushStorage().claim(
        sessionId: 'session-b',
        eventId: 'episode-b',
        capacity: 2,
      ),
      isTrue,
    );
    final keys = jsonDecode(
      (await platform.read(key: SecurePushStorage.eventsKey))!,
    ) as List;
    expect(keys.length, 2);
    expect(keys.first, ['session-b', 'episode-a']);
    // Eviction deliberately permits old replay, not an exactly-once guarantee.
    expect(
      await SecurePushStorage().claim(
        sessionId: 'session-a',
        eventId: 'episode-a',
        capacity: 2,
      ),
      isTrue,
    );
  });

  test(
    'smaller capacity bounds a previously larger store even on duplicate',
    () async {
      final store = SecurePushStorage();
      for (final id in ['a', 'b', 'c']) {
        await store.claim(sessionId: 'session', eventId: id, capacity: 3);
      }
      expect(
        await store.claim(sessionId: 'session', eventId: 'c', capacity: 1),
        isFalse,
      );
      expect(
        jsonDecode((await platform.read(key: SecurePushStorage.eventsKey))!),
        [
          ['session', 'c'],
        ],
      );
    },
  );

  test(
    'corrupt event storage fails closed and explicit clear can recover',
    () async {
      for (final raw in [
        'not-json',
        '{}',
        '[1]',
        '[["a"]]',
        '[["a",3]]',
        '[["bad/id","b"]]',
        '[["a","b"],["a","b"]]',
        'x' * 300001,
        jsonEncode(List.generate(1025, (i) => ['session', 'event-$i'])),
      ]) {
        await platform.write(key: SecurePushStorage.eventsKey, value: raw);
        await expectLater(
          SecurePushStorage().claim(
            sessionId: 'session',
            eventId: 'event',
            capacity: 2,
          ),
          throwsA(isA<PushStorageException>()),
        );
        expect(await platform.read(key: SecurePushStorage.eventsKey), raw);
        await SecurePushStorage().clear();
        expect(
          await SecurePushStorage().claim(
            sessionId: 'session',
            eventId: 'event',
            capacity: 2,
          ),
          isTrue,
        );
      }
    },
  );

  test(
    'corrupt installation is not silently replaced or treated as registered',
    () async {
      await platform.write(
        key: SecurePushStorage.installationKey,
        value: 'broken',
      );
      await expectLater(
        SecurePushStorage().installationId(),
        throwsA(isA<PushStorageException>()),
      );
      expect(
        await platform.read(key: SecurePushStorage.installationKey),
        'broken',
      );
    },
  );

  test('invalid claim bounds and IDs do not write', () async {
    for (final capacity in [0, 1025]) {
      await expectLater(
        SecurePushStorage().claim(
          sessionId: 'session',
          eventId: 'event',
          capacity: capacity,
        ),
        throwsA(isA<PushStorageException>()),
      );
    }
    await expectLater(
      SecurePushStorage().claim(
        sessionId: '../other',
        eventId: 'event',
        capacity: 1,
      ),
      throwsA(isA<PushStorageException>()),
    );
    expect(await platform.read(key: SecurePushStorage.eventsKey), isNull);
  });
}
