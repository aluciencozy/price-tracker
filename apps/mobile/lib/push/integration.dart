import 'dart:async';

import 'package:flutter/material.dart';

import '../client/mobile_api.dart';
import '../client/session_controller.dart';
import '../screens.dart';
import '../tracker_repository.dart';
import 'device_api.dart';
import 'events.dart';
import 'registration.dart';
import 'storage.dart';

/// Explicit adapter boundary; no FCM listener or pending/cold-start event queue.
class PushEventDispatcher {
  PushIntegrationController? _controller;
  Future<ForegroundPushResult> foreground(Map<String, Object?> data) async =>
      _controller?.foreground(data) ?? ForegroundPushResult.wrongSession;
  Future<PushTapResult> tap(Map<String, Object?> data) async =>
      _controller?.tap(data) ?? PushTapResult.wrongSession;
  Future<void> tokenChanged() async => _controller?.synchronize();
}

class _StoredDeviceEndpoint implements DeviceEndpoint {
  _StoredDeviceEndpoint(this.api, this.storage, this.origin);
  final MobileApi api;
  final PushStorage storage;
  final String origin;
  HttpDeviceEndpoint? _endpoint;
  Future<HttpDeviceEndpoint> _get() async => _endpoint ??= HttpDeviceEndpoint(
    client: api.client,
    baseUrl: origin,
    installationId: await storage.installationId(),
  );
  @override
  Future<PushDevice> register(PushSession session, String token) async =>
      (await _get()).register(session, token);
  @override
  Future<PushDevice> update(
    PushSession session,
    String id,
    String token,
  ) async => (await _get()).update(session, id, token);
  @override
  Future<void> unregister(PushSession session, String id) async =>
      (await _get()).unregister(session, id);
}

class PushIntegrationController extends ChangeNotifier {
  PushIntegrationController({
    required this.session,
    required DeviceEndpoint devices,
    required this.storage,
    PushPermissionGateway gateway = const UnconfiguredPushGateway(),
  }) {
    registration = PushRegistration(
      devices: devices,
      readSession: _snapshot,
      gateway: gateway,
    );
    events = PushEvents(
      readSession: _snapshot,
      store: storage,
      onForeground: (_) {
        notice =
            'Price alert received. Open the game to check its current details.';
        _showNotice();
      },
      readOwnedTracker: (owner, id) async {
        final navigation = _navigation;
        if (navigation == null || _snapshot()?.id != owner.id) {
          throw StateError('No current route');
        }
        try {
          final tracker = await navigation.repository.get(id);
          if (!identical(navigation, _navigation)) {
            throw StateError('Route changed');
          }
          return AuthorizedPushTracker(
            id: tracker.id,
            productId: tracker.product.id,
          );
        } on RepositoryException catch (error) {
          if (error.code == 'NOT_FOUND') return null;
          if (error.expired) throw const PushSessionExpired();
          rethrow;
        }
      },
      openTracker: (tracker) => _navigation?.open(tracker.id),
    );
    session.addListener(_changed);
    _changed();
  }

  final SessionController session;
  final PushStorage storage;
  late final PushRegistration registration;
  late final PushEvents events;
  PushSession? _current;
  _PushTrackerNavigationState? _navigation;
  bool _disposed = false, _ready = true, busy = false;
  bool localCleanupFailed = false;
  String? notice;
  int _epoch = 0;
  DateTime? _retryAt;
  int get retrySeconds {
    final milliseconds =
        _retryAt?.difference(DateTime.now()).inMilliseconds ?? 0;
    return milliseconds > 0 ? (milliseconds / 1000).ceil() : 0;
  }

  PushSession? _snapshot() =>
      !_disposed && session.sessionId == _current?.id && session.user != null
      ? _current
      : null;
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void _showNotice() {
    _navigation?.showNotice(notice);
    _notify();
  }

  void _rememberWait() {
    final wait = registration.retryAfterSeconds;
    _retryAt = wait == null
        ? null
        : DateTime.now().add(Duration(seconds: wait));
  }

  void _changed() {
    final active = session.activeSession;
    if (active?.sessionId == _current?.id) return;
    final hadSession = _current != null;
    _current = active == null
        ? null
        : PushSession(id: active.sessionId, bearerToken: active.accessToken);
    _navigation = null;
    notice = null;
    _retryAt = null;
    final epoch = ++_epoch;
    _ready = !hadSession && !localCleanupFailed;
    // synchronize clears the old local binding synchronously; its DELETE uses
    // captured credentials and never MobileApi's current-session 401 callback.
    final registrationWork = registration.synchronize();
    () async {
      if (hadSession || localCleanupFailed) await _clearEvents();
      await registrationWork;
      if (_disposed || epoch != _epoch) return;
      _ready = !localCleanupFailed;
      _rememberWait();
      _notify();
    }().ignore();
    _notify();
  }

  Future<void> _clearEvents() async {
    try {
      await storage.clear();
      localCleanupFailed = false;
    } catch (_) {
      localCleanupFailed = true;
    }
  }

  Future<void> synchronize({bool requestPermission = false}) async {
    if (_disposed || busy || retrySeconds > 0) return;
    busy = true;
    final epoch = _epoch;
    _notify();
    try {
      if (localCleanupFailed) {
        await _clearEvents();
        _ready = !localCleanupFailed;
      }
      await registration.synchronize(requestPermission: requestPermission);
      if (epoch == _epoch) {
        _rememberWait();
      }
    } finally {
      busy = false;
      _notify();
    }
  }

  Future<ForegroundPushResult> foreground(Map<String, Object?> data) async {
    if (_snapshot() == null) return ForegroundPushResult.wrongSession;
    if (!_ready) return ForegroundPushResult.storageUnavailable;
    final owner = _snapshot()?.id;
    final result = await events.foreground(data);
    if (result == ForegroundPushResult.storageUnavailable &&
        owner == _snapshot()?.id) {
      notice = 'Local alert keys are unavailable or invalid. No alert was displayed.';
      _showNotice();
    }
    return result;
  }

  Future<void> clearAlertKeys() async {
    if (_disposed || busy) return;
    busy = true;
    _ready = false;
    _notify();
    await _clearEvents();
    _ready = !localCleanupFailed;
    busy = false;
    notice = localCleanupFailed
        ? 'Could not clear local alert keys. No server revocation is implied.'
        : 'Local alert keys cleared. Old alerts may appear again; device registration is unchanged.';
    _showNotice();
  }

  Future<PushTapResult> tap(Map<String, Object?> data) async {
    final owner = _snapshot()?.id;
    final result = await events.tap(data);
    if (owner != null && _snapshot()?.id == owner) {
      notice = switch (result) {
        PushTapResult.notFound => 'That tracked game is no longer available.',
        PushTapResult.sessionExpired =>
          'Your session ended. Please sign in again.',
        PushTapResult.unavailable =>
          'Could not open the alert. Check your connection and try again.',
        PushTapResult.invalid =>
          'This alert is unsupported or does not match the tracked game.',
        _ => null,
      };
      _showNotice();
    }
    return result;
  }

  @override
  void dispose() {
    session.removeListener(_changed);
    _disposed = true;
    _current = null;
    _navigation = null;
    registration.synchronize().ignore();
    super.dispose();
  }
}

class PushSessionIntegration extends StatefulWidget {
  const PushSessionIntegration({
    super.key,
    required this.session,
    required this.api,
    required this.origin,
    required this.child,
    this.storage,
    this.gateway = const UnconfiguredPushGateway(),
    this.dispatcher,
  });
  final SessionController session;
  final MobileApi api;
  final String origin;
  final Widget child;
  final PushStorage? storage;
  final PushPermissionGateway gateway;
  final PushEventDispatcher? dispatcher;
  @override
  State<PushSessionIntegration> createState() => _PushSessionIntegrationState();
}

class _PushSessionIntegrationState extends State<PushSessionIntegration> {
  late final PushIntegrationController controller;
  @override
  void initState() {
    super.initState();
    final storage = widget.storage ?? SecurePushStorage();
    controller = PushIntegrationController(
      session: widget.session,
      storage: storage,
      devices: _StoredDeviceEndpoint(widget.api, storage, widget.origin),
      gateway: widget.gateway,
    );
    widget.dispatcher?._controller = controller;
  }

  @override
  void dispose() {
    if (identical(widget.dispatcher?._controller, controller)) {
      widget.dispatcher?._controller = null;
    }
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      PushIntegrationScope(controller: controller, child: widget.child);
}

class PushIntegrationScope
    extends InheritedNotifier<PushIntegrationController> {
  const PushIntegrationScope({
    super.key,
    required PushIntegrationController controller,
    required super.child,
  }) : super(notifier: controller);
  static PushIntegrationController? maybeOf(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<PushIntegrationScope>()
      ?.notifier;
}

/// Mounted inside the session-keyed navigator, never the public root navigator.
class PushTrackerNavigation extends StatefulWidget {
  const PushTrackerNavigation({
    super.key,
    required this.repository,
    required this.child,
  });
  final TrackerRepository repository;
  final Widget child;
  @override
  State<PushTrackerNavigation> createState() => _PushTrackerNavigationState();
}

class _PushTrackerNavigationState extends State<PushTrackerNavigation> {
  PushIntegrationController? controller;
  TrackerRepository get repository => widget.repository;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    controller = PushIntegrationScope.maybeOf(context);
    controller?._navigation = this;
  }

  void open(String id) {
    if (!mounted) return;
    Navigator.of(context)
        .push(
          MaterialPageRoute<void>(
            builder: (_) => DetailScreen(repository: repository, trackerId: id),
          ),
        )
        .ignore();
  }

  void showNotice(String? message) {
    if (!mounted || message == null) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  void dispose() {
    if (identical(controller?._navigation, this)) {
      controller?._navigation = null;
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

class PushAccountStatus extends StatefulWidget {
  const PushAccountStatus({super.key});
  @override
  State<PushAccountStatus> createState() => _PushAccountStatusState();
}

class _PushAccountStatusState extends State<PushAccountStatus> {
  Timer? _timer;
  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = PushIntegrationScope.maybeOf(context);
    if (controller == null) return const SizedBox.shrink();
    final status = controller.registration.status;
    final message = switch (status) {
      PushStatus.unconfigured => 'Unconfigured — no Android push provider or permission/token gateway is installed. No device delivery is enabled.',
      PushStatus.signedOut => 'Sign in to manage this device.',
      PushStatus.denied => 'Notification permission denied. Change Android permission settings, then retry.',
      PushStatus.noToken => 'Permission allowed, but no device token is available. Retry after the provider supplies a token.',
      PushStatus.offline => 'Device registration unavailable or offline. It is not confirmed for the current token.',
      PushStatus.registered => 'Device registered with the API. Notification receipt and delivery are not verified.',
      PushStatus.error => 'Device registration failed. Check your session or local push storage and retry.',
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Android push readiness',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        Text(message),
        const Text(
          'A saved tracker push preference is separate from permission, device registration, and delivery.',
        ),
        if (controller.registration.revocation == PushRevocation.unconfirmed)
          const Text(
            'Earlier device removal was not confirmed. Local sign-out does not prove server revocation.',
          ),
        if (controller.localCleanupFailed)
          const Text(
            'Local alert keys could not be cleared. Foreground events are blocked; retry cleanup.',
          ),
        if (controller.notice != null)
          Text(controller.notice!, semanticsLabel: controller.notice),
        if (status != PushStatus.unconfigured || controller.localCleanupFailed)
          OutlinedButton(
            onPressed: controller.busy || controller.retrySeconds > 0
                ? null
                : () => controller.synchronize(requestPermission: true),
            child: Text(
              controller.busy
                  ? 'Checking device…'
                  : controller.retrySeconds > 0
                  ? 'Retry device in ${controller.retrySeconds} seconds'
                  : 'Check permission / retry device',
            ),
          ),
        if (controller.notice != null || controller.localCleanupFailed)
          TextButton(
            onPressed: controller.busy ? null : controller.clearAlertKeys,
            child: const Text(
              'Clear local alert keys (allows old alerts again)',
            ),
          ),
      ],
    );
  }
}
