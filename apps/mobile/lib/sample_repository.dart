import 'tracker_repository.dart';

enum SampleScenario { normal, empty, offline, expired, stale, missingOffer }

// Only the two validated identities from docs/cheapshark-proof.json.
final sampleProducts = List<Product>.unmodifiable([
  Product(
    id: 'sample-product-36',
    providerGameId: '36',
    steamAppId: '620',
    title: 'Portal 2',
    price: Money(999),
    observedAt: DateTime.utc(2026, 10, 26, 16, 34, 31),
    providerChangedAt: null,
    purchaseUrl: Uri.parse(
      'https://www.cheapshark.com/redirect?dealID=rwQ2JCEr5NOySyBsAj6fyPuZg4qMlh9w67U%2BmM6b2VE%3D',
    ),
  ),
  Product(
    id: 'sample-product-59',
    providerGameId: '59',
    steamAppId: '220',
    title: 'Half-Life 2',
    price: Money(999),
    observedAt: DateTime.utc(2026, 10, 26, 16, 34, 42),
    providerChangedAt: null,
    purchaseUrl: Uri.parse(
      'https://www.cheapshark.com/redirect?dealID=Vz5eZMF1sKvs02I4cuEgrGnmM1r%2BkWHig0YMa0lJ0vM%3D',
    ),
  ),
]);

class SampleTrackerRepository implements TrackerRepository {
  SampleTrackerRepository({
    this.delay = const Duration(milliseconds: 180),
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now {
    reset();
  }
  final Duration delay;
  final DateTime Function() _now;
  final Map<String, Tracker> _trackers = {};
  final Map<String, ProductPreview> _previews = {};
  var _nextId = 0;
  SampleScenario scenario = SampleScenario.normal;

  void reset({bool empty = false}) {
    scenario = SampleScenario.normal;
    _trackers.clear();
    _previews.clear();
    if (!empty) {
      for (final product in sampleProducts) {
        final id = 'sample-tracker-${++_nextId}';
        _trackers[id] = Tracker(
          id: id,
          product: product,
          targetPrice: Money(499),
          enabled: true,
          alerts: const AlertPreferences(email: true, push: false),
          createdAt: DateTime.utc(2026, 10, 26),
          updatedAt: DateTime.utc(2026, 10, 26),
        );
      }
    }
  }

  Future<void> _ready() async {
    if (delay > Duration.zero) {
      await Future<void>.delayed(delay);
    }
    if (scenario == SampleScenario.expired) {
      throw const RepositoryException(
        'Sample session expired. Return to account to preview sign in.',
        expired: true,
      );
    }
    if (scenario == SampleScenario.offline) {
      throw const RepositoryException(
        'Sample offline state. Nothing was changed. Choose Normal in sample scenarios to recover.',
      );
    }
  }

  Product _display(Product product) {
    if (scenario == SampleScenario.stale) {
      return product.withFailure();
    }
    if (scenario == SampleScenario.missingOffer) {
      return Product(
        id: product.id,
        providerGameId: product.providerGameId,
        steamAppId: product.steamAppId,
        title: product.title,
        price: null,
        observedAt: null,
        providerChangedAt: null,
        purchaseUrl: null,
        freshness: 'unavailable',
        lastError: 'Illustrative missing Steam offer without retained observations. No other store is substituted.',
      );
    }
    return product;
  }

  Tracker _displayTracker(Tracker item) => Tracker(
    id: item.id,
    product: _display(item.product),
    targetPrice: item.targetPrice,
    enabled: item.enabled,
    alerts: item.alerts,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  );

  @override
  Future<List<Tracker>> list({String search = ''}) async {
    await _ready();
    return _trackers.values
        .where(
          (item) => item.product.title.toLowerCase().contains(
            search.trim().toLowerCase(),
          ),
        )
        .map(_displayTracker)
        .toList(growable: false);
  }

  @override
  Future<Tracker> get(String id) async {
    await _ready();
    final item = _trackers[id];
    if (item == null) {
      throw const RepositoryException(
        'This tracker was removed. Return to the watchlist.',
      );
    }
    return _displayTracker(item);
  }

  @override
  Future<ProductPreview> preview(String steamUrl) async {
    await _ready();
    final appId = parseSteamAppId(steamUrl);
    final matches = sampleProducts.where(
      (product) => product.steamAppId == appId,
    );
    if (matches.isEmpty) {
      throw const RepositoryException(
        'Unsupported or unknown base game, DLC, or edition. Only Portal 2 (620) and Half-Life 2 (220) are validated in this sample.',
      );
    }
    final product = _display(matches.single);
    if (product.price == null) {
      throw const RepositoryException(
        'No supported Steam offer is available. Nothing was saved.',
      );
    }
    final now = _now().toUtc();
    _previews.removeWhere((_, value) => !value.expiresAt.isAfter(now));
    final preview = ProductPreview(
      id: 'sample-preview-${++_nextId}',
      expiresAt: now.add(const Duration(minutes: 10)),
      product: product,
    );
    _previews[preview.id] = preview;
    return preview;
  }

  @override
  Future<Tracker> create({
    required String previewId,
    required Money targetPrice,
    required bool enabled,
    required AlertPreferences alerts,
  }) async {
    await _ready();
    final preview = _previews[previewId];
    if (preview == null || !preview.expiresAt.isAfter(_now().toUtc())) {
      throw const RepositoryException(
        'This sample preview expired. Change the link and preview it again.',
      );
    }
    if (scenario == SampleScenario.missingOffer) {
      throw const RepositoryException('No supported Steam offer is available.');
    }
    final product = preview.product;
    if (_trackers.values.any(
      (item) => item.product.identity == product.identity,
    )) {
      throw const RepositoryException(
        'This Steam offer is already in your watchlist. Edit the existing tracker instead.',
      );
    }
    final now = _now().toUtc();
    final item = Tracker(
      id: 'sample-tracker-${++_nextId}',
      product: product,
      targetPrice: targetPrice,
      enabled: enabled,
      alerts: alerts,
      createdAt: now,
      updatedAt: now,
    );
    _trackers[item.id] = item;
    return item;
  }

  @override
  Future<Tracker> update(
    String id, {
    required Money targetPrice,
    required bool enabled,
    required AlertPreferences alerts,
  }) async {
    await _ready();
    final previous = _trackers[id];
    if (previous == null) {
      throw const RepositoryException('This tracker was removed.');
    }
    final item = Tracker(
      id: id,
      product: previous.product,
      targetPrice: targetPrice,
      enabled: enabled,
      alerts: alerts,
      createdAt: previous.createdAt,
      updatedAt: _now().toUtc(),
    );
    _trackers[id] = item;
    return _displayTracker(item);
  }

  @override
  Future<void> delete(String id) async {
    await _ready();
    if (_trackers.remove(id) == null) {
      throw const RepositoryException('This tracker was already removed.');
    }
  }

  @override
  Future<List<Observation>> history(String trackerId) async {
    await get(trackerId);
    if (scenario == SampleScenario.missingOffer) {
      return [];
    }
    // Illustrative values, never recorded Steam history.
    return [
      Observation(DateTime.utc(2026, 10, 24), Money(1299)),
      Observation(DateTime.utc(2026, 10, 25), Money(999)),
      Observation(DateTime.utc(2026, 10, 26), Money(999)),
    ];
  }
}
