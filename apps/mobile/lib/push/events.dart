import 'device_api.dart';
import 'validation.dart';

/// A routing hint, not authoritative game/price data or proof of ownership.
class PushEvent {
  const PushEvent._({
    required this.eventId,
    required this.deliveryId,
    required this.recipientSessionId,
    required this.trackedItemId,
    required this.productId,
    required this.observedAt,
  });

  final String eventId;
  final String deliveryId;
  final String recipientSessionId;
  final String trackedItemId;
  final String productId;
  final DateTime observedAt;

  static const _fields = {
    'schemaVersion',
    'type',
    'eventId',
    'deliveryId',
    'recipientSessionId',
    'trackedItemId',
    'productId',
    'observedAt',
  };

  static PushEvent parse(Map<String, Object?> raw) {
    if (raw.length != _fields.length ||
        !_fields.every(raw.containsKey) ||
        raw.values.any((value) => value is! String)) {
      throw const FormatException('Expected a strict push-event string map');
    }
    final data = raw.cast<String, String>();
    if (data['schemaVersion'] != '1' ||
        data['type'] != 'price_target_reached') {
      throw const FormatException('Unsupported push event');
    }
    for (final key in [
      'eventId',
      'deliveryId',
      'recipientSessionId',
      'trackedItemId',
      'productId',
    ]) {
      if (!isPushId(data[key]!)) {
        throw const FormatException('Invalid push-event ID');
      }
    }
    return PushEvent._(
      eventId: data['eventId']!,
      deliveryId: data['deliveryId']!,
      recipientSessionId: data['recipientSessionId']!,
      trackedItemId: data['trackedItemId']!,
      productId: data['productId']!,
      observedAt: parsePushTimestamp(data['observedAt']!),
    );
  }
}

/// Supply durable storage before wiring real events. Atomically return false for
/// an existing (sessionId,eventId); otherwise insert and evict oldest keys so at
/// most capacity entries remain in total. Store keys only, not payloads/tokens.
abstract interface class PushEventStore {
  Future<bool> claim({
    required String sessionId,
    required String eventId,
    required int capacity,
  });
  Future<void> clear();
}

/// Returned only after an authenticated owned-tracker API read, not from FCM.
class AuthorizedPushTracker {
  const AuthorizedPushTracker({required this.id, required this.productId});
  final String id;
  final String productId;
}

/// The injected owned-tracker reader maps HTTP 401 to this and 404 to null.
class PushSessionExpired implements Exception {
  const PushSessionExpired();
}

enum ForegroundPushResult {
  invalid,
  wrongSession,
  duplicate,
  storageUnavailable,
  accepted,
}

enum PushTapResult {
  invalid,
  wrongSession,
  notFound,
  sessionExpired,
  unavailable,
  opened,
}

class PushEvents {
  PushEvents({
    required this.readSession,
    required this.store,
    required this.onForeground,
    required this.readOwnedTracker,
    required this.openTracker,
    this.capacity = 512,
  }) {
    if (capacity < 1 || capacity > 1024) {
      throw ArgumentError('Push deduplication capacity must be 1–1024');
    }
  }

  final PushSession? Function() readSession;
  final PushEventStore store;
  final void Function(PushEvent event) onForeground;
  final Future<AuthorizedPushTracker?> Function(
    PushSession session,
    String trackedItemId,
  )
  readOwnedTracker;
  final void Function(AuthorizedPushTracker tracker) openTracker;
  final int capacity;

  PushEvent? _parse(Map<String, Object?> raw) {
    try {
      return PushEvent.parse(raw);
    } on FormatException {
      return null;
    }
  }

  Future<ForegroundPushResult> foreground(Map<String, Object?> raw) async {
    final event = _parse(raw);
    if (event == null) return ForegroundPushResult.invalid;
    if (readSession()?.id != event.recipientSessionId) {
      return ForegroundPushResult.wrongSession;
    }
    final bool claimed;
    try {
      claimed = await store.claim(
        sessionId: event.recipientSessionId,
        eventId: event.eventId,
        capacity: capacity,
      );
    } catch (_) {
      return ForegroundPushResult.storageUnavailable;
    }
    if (readSession()?.id != event.recipientSessionId) {
      return ForegroundPushResult.wrongSession;
    }
    if (!claimed) return ForegroundPushResult.duplicate;
    onForeground(event);
    return ForegroundPushResult.accepted;
  }

  Future<PushTapResult> tap(Map<String, Object?> raw) async {
    final event = _parse(raw);
    if (event == null) return PushTapResult.invalid;
    final session = readSession();
    if (session == null || session.id != event.recipientSessionId) {
      return PushTapResult.wrongSession;
    }
    final AuthorizedPushTracker? tracker;
    try {
      tracker = await readOwnedTracker(session, event.trackedItemId);
    } on PushSessionExpired {
      if (readSession()?.id != session.id) return PushTapResult.wrongSession;
      return PushTapResult.sessionExpired;
    } catch (_) {
      if (readSession()?.id != session.id) return PushTapResult.wrongSession;
      return PushTapResult.unavailable;
    }
    if (readSession()?.id != session.id) return PushTapResult.wrongSession;
    if (tracker == null) return PushTapResult.notFound;
    if (tracker.id != event.trackedItemId ||
        tracker.productId != event.productId) {
      return PushTapResult.invalid;
    }
    openTracker(tracker);
    return PushTapResult.opened;
  }
}
