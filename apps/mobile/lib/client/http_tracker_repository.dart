import 'dart:convert';
import 'dart:math';

import '../tracker_repository.dart' as ui;
import '../request_feedback.dart';
import 'mobile_api.dart';
import 'models.dart' as wire;

class HttpTrackerRepository
    implements ui.PagedTrackerRepository, ui.HistoryMetadataRepository {
  HttpTrackerRepository(this.api);
  final MobileApi api;
  bool _active = true;
  int _searchVersion = 0;
  String _search = '';
  String? _cursor;
  List<ui.Tracker> _items = [];
  final Map<String, String> _saveKeys = {};
  final Map<String, wire.History> historyMetadata = {};
  DateTime? _retryAt;
  @override
  ui.HistoryMetadata? historyMetadataFor(String id) {
    final value = historyMetadata[id];
    return value == null
        ? null
        : ui.HistoryMetadata(value.from, value.to, value.retainedFrom);
  }

  @override
  bool get hasMore => _cursor != null;

  void dispose() {
    _active = false;
    _items = [];
    _cursor = null;
    _saveKeys.clear();
    historyMetadata.clear();
  }

  void _check() {
    if (!_active) {
      throw const ui.RepositoryException(
        'This session ended. Please sign in again.',
        expired: true,
      );
    }
  }

  void _ready() {
    _check();
    final wait = _retryAt?.difference(DateTime.now()).inMilliseconds ?? 0;
    if (wait > 0) {
      throw ui.RepositoryException(
        'The API asked us to wait before trying again.',
        retryAfterSeconds: (wait / 1000).ceil(),
      );
    }
  }

  Future<T> _call<T>(Future<T> Function() action) async {
    _ready();
    try {
      final value = await action();
      _check();
      return value;
    } on ApiFailure catch (error) {
      if (error.retryAfterSeconds != null) {
        _retryAt = DateTime.now().add(
          Duration(seconds: error.retryAfterSeconds!),
        );
      }
      throw ui.RepositoryException(
        requestMessage(error),
        code: error.code,
        expired:
            error.status == 401 ||
            [
              'AUTH_REQUIRED',
              'SESSION_EXPIRED',
              'SESSION_CHANGED',
            ].contains(error.code),
        retryAfterSeconds: error.retryAfterSeconds,
        resourceId: error.resourceId,
      );
    }
  }

  @override
  Future<List<ui.Tracker>> list({String search = ''}) => _call(() async {
    final version = ++_searchVersion;
    _search = search.trim();
    _cursor = null;
    final page = await api.list(search: _search);
    _check();
    final items = page.items.map(_tracker).toList();
    if (version == _searchVersion) {
      _items = items;
      _cursor = page.nextCursor;
    }
    return items;
  });
  @override
  Future<List<ui.Tracker>> loadMore() => _call(() async {
    final cursor = _cursor;
    final version = _searchVersion;
    if (cursor == null) return List.unmodifiable(_items);
    final page = await api.list(search: _search, cursor: cursor);
    _check();
    if (version != _searchVersion) {
      throw const ui.RepositoryException('Search changed. Refresh the list.');
    }
    if (page.nextCursor == cursor) {
      throw const ui.RepositoryException(
        'Invalid pagination response. Refresh the list.',
      );
    }
    final merged = {
      for (final item in _items) item.id: item,
      for (final item in page.items.map(_tracker)) item.id: item,
    };
    _items = merged.values.toList();
    _cursor = page.nextCursor;
    return List.unmodifiable(_items);
  });
  @override
  Future<ui.Tracker> get(String id) =>
      _call(() async => _tracker(await api.get(id)));
  @override
  Future<ui.ProductPreview> preview(String steamUrl) => _call(() async {
    ui.parseSteamAppId(steamUrl);
    final preview = await api.preview(steamUrl.trim());
    if (preview.product.currentPrice == null) {
      throw const ui.RepositoryException(
        'No supported Steam offer is available. Nothing was saved.',
      );
    }
    return ui.ProductPreview(
      id: preview.id,
      expiresAt: preview.expiresAt,
      product: _product(preview.product),
    );
  });
  @override
  Future<List<ui.Observation>> history(String trackerId) => _call(() async {
    var page = await api.history(trackerId);
    final first = page;
    final items = [...page.page.items];
    final cursors = <String>{};
    // Bound work for the small MVP. Never silently truncate real observations.
    while (page.page.nextCursor != null) {
      final cursor = page.page.nextCursor!;
      if (!cursors.add(cursor) || cursors.length > 100) {
        throw const ui.RepositoryException(
          'History is too large or pagination is invalid. Try again later.',
        );
      }
      _ready();
      page = await api.history(
        trackerId,
        from: first.from,
        to: first.to,
        cursor: cursor,
      );
      if (page.from != first.from || page.to != first.to) {
        throw const ui.RepositoryException(
          'History window changed unexpectedly. Try again.',
        );
      }
      items.addAll(page.page.items);
    }
    _check();
    historyMetadata[trackerId] = first;
    final unique = {for (final item in items) item.id: item}.values.toList()
      ..sort((a, b) => a.observedAt.compareTo(b.observedAt));
    return unique
        .map(
          (item) =>
              ui.Observation(item.observedAt, ui.Money(item.price.amountMinor)),
        )
        .toList();
  });
  @override
  Future<ui.Tracker> create({
    required String previewId,
    required ui.Money targetPrice,
    required bool enabled,
    required ui.AlertPreferences alerts,
  }) => _call(() async {
    final intent = jsonEncode([
      previewId,
      targetPrice.amountMinor,
      enabled,
      alerts.email,
      alerts.push,
    ]);
    final key = _saveKeys.putIfAbsent(intent, _uuid);
    final item = await api.create(
      previewId: previewId,
      targetPrice: wire.Money(targetPrice.amountMinor),
      enabled: enabled,
      alerts: _alerts(alerts),
      idempotencyKey: key,
    );
    _check();
    _saveKeys.remove(intent);
    return _tracker(item);
  });
  @override
  Future<ui.Tracker> update(
    String id, {
    required ui.Money targetPrice,
    required bool enabled,
    required ui.AlertPreferences alerts,
  }) => _call(
    () async => _tracker(
      await api.update(
        id,
        targetPrice: wire.Money(targetPrice.amountMinor),
        enabled: enabled,
        alerts: _alerts(alerts),
      ),
    ),
  );
  @override
  Future<void> delete(String id) => _call(() async {
    await api.delete(id);
    _check();
    historyMetadata.remove(id);
  });

  static wire.Alerts _alerts(ui.AlertPreferences value) =>
      wire.Alerts(email: value.email, push: value.push);
  static ui.Product _product(wire.Product p) => ui.Product(
    id: p.id,
    providerGameId: p.identity.providerGameId,
    steamAppId: p.steamAppId,
    title: p.title,
    price: p.currentPrice == null
        ? null
        : ui.Money(p.currentPrice!.amountMinor),
    retailPrice: p.retailPrice == null
        ? null
        : ui.Money(p.retailPrice!.amountMinor),
    observedAt: p.observedAt,
    providerChangedAt: p.providerChangedAt,
    purchaseUrl: p.purchaseUrl == null ? null : Uri.parse(p.purchaseUrl!),
    freshness: p.freshness,
    lastError: p.lastError?.message,
    lastAttemptAt: p.lastAttemptAt,
    staleAt: p.staleAt,
    nextCheckAt: p.nextCheckAt,
    attribution: p.source.attribution,
  );
  static ui.Tracker _tracker(wire.TrackedItem item) => ui.Tracker(
    id: item.id,
    product: _product(item.product),
    targetPrice: ui.Money(item.targetPrice.amountMinor),
    enabled: item.enabled,
    alerts: ui.AlertPreferences(
      email: item.alerts.email,
      push: item.alerts.push,
    ),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  );
  static String _uuid() {
    final random = Random.secure();
    final bytes = List.generate(16, (_) => random.nextInt(256));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  }
}
