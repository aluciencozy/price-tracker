// UI domain values. Exact JSON serialization belongs to the separate API adapter.
class Money {
  Money(this.amountMinor) {
    if (amountMinor < 0 || amountMinor > 9007199254740991) {
      throw ArgumentError('USD cents must be a nonnegative safe integer.');
    }
  }
  final int amountMinor;
  String get currency => 'USD';
  String get formatted =>
      '\$${amountMinor ~/ 100}.${(amountMinor % 100).toString().padLeft(2, '0')}';
  String get input => formatted.substring(1);
  static Money parse(String input) {
    final text = input.trim();
    if (!RegExp(r'^\d+(\.\d{1,2})?$').hasMatch(text)) {
      throw const FormatException(
        'Enter a USD amount with up to two decimal places, including 0.',
      );
    }
    final parts = text.split('.');
    final cents =
        BigInt.parse(parts.first) * BigInt.from(100) +
        BigInt.parse(parts.length == 1 ? '0' : parts.last.padRight(2, '0'));
    if (cents > BigInt.from(9007199254740991)) {
      throw const FormatException('That target is too large.');
    }
    return Money(cents.toInt());
  }
}

class AlertPreferences {
  const AlertPreferences({required this.email, required this.push});
  final bool email;
  final bool push;
}

class Product {
  const Product({
    required this.id,
    required this.providerGameId,
    required this.steamAppId,
    required this.title,
    required this.price,
    required this.observedAt,
    required this.providerChangedAt,
    required this.purchaseUrl,
    this.freshness = 'stale',
    this.lastError,
    this.lastAttemptAt,
    this.staleAt,
    this.nextCheckAt,
    this.retailPrice,
    this.attribution = 'Prices supplied by CheapShark; Steam US/USD base-game offer, excluding taxes and checkout adjustments.',
  });
  final String id;
  final String providerGameId;
  final String steamAppId;
  final String title;
  final Money? price;
  final DateTime? observedAt;
  final DateTime? providerChangedAt;
  final DateTime? lastAttemptAt;
  final DateTime? staleAt, nextCheckAt;
  final Money? retailPrice;
  final String attribution;
  final String? lastError;
  final String freshness;
  final Uri? purchaseUrl;
  String get provider => 'cheapshark';
  String get storeId => '1';
  String get market => 'US';
  String get currency => 'USD';
  String get source => 'CheapShark';
  String get identity => '$provider:$providerGameId:$storeId:$market:$currency';
  String get artwork => 'assets/covers/$steamAppId.jpg';
  Product withFailure() => Product(
    id: id,
    providerGameId: providerGameId,
    steamAppId: steamAppId,
    title: title,
    price: price,
    observedAt: observedAt,
    providerChangedAt: providerChangedAt,
    purchaseUrl: purchaseUrl,
    lastAttemptAt: DateTime.utc(2026, 10, 28),
    lastError: 'Illustrative failed check. Last successful price retained.',
  );
}

class ProductPreview {
  const ProductPreview({
    required this.id,
    required this.expiresAt,
    required this.product,
  });
  final String id;
  final DateTime expiresAt;
  final Product product;
}

class Tracker {
  const Tracker({
    required this.id,
    required this.product,
    required this.targetPrice,
    required this.enabled,
    required this.alerts,
    required this.createdAt,
    required this.updatedAt,
  });
  final String id;
  final Product product;
  final Money targetPrice;
  final bool enabled;
  final AlertPreferences alerts;
  final DateTime createdAt;
  final DateTime updatedAt;
}

class Observation {
  const Observation(this.observedAt, this.price);
  final DateTime observedAt;
  final Money price;
}

class RepositoryException implements Exception {
  const RepositoryException(
    this.message, {
    this.expired = false,
    this.code,
    this.retryAfterSeconds,
    this.resourceId,
  });
  final String message;
  final bool expired;
  final String? code, resourceId;
  final int? retryAfterSeconds;
  @override
  String toString() => message;
}

abstract interface class PagedTrackerRepository implements TrackerRepository {
  bool get hasMore;
  Future<List<Tracker>> loadMore();
}

class HistoryMetadata {
  const HistoryMetadata(this.from, this.to, this.retainedFrom);
  final DateTime from, to, retainedFrom;
}

abstract interface class HistoryMetadataRepository {
  HistoryMetadata? historyMetadataFor(String id);
}

abstract interface class TrackerRepository {
  Future<List<Tracker>> list({String search = ''});
  Future<Tracker> get(String id);
  Future<ProductPreview> preview(String steamUrl);
  Future<List<Observation>> history(String trackerId);
  Future<Tracker> create({
    required String previewId,
    required Money targetPrice,
    required bool enabled,
    required AlertPreferences alerts,
  });
  Future<Tracker> update(
    String id, {
    required Money targetPrice,
    required bool enabled,
    required AlertPreferences alerts,
  });
  Future<void> delete(String id);
}

String parseSteamAppId(String input) {
  final uri = Uri.tryParse(input.trim());
  if (input.length > 2048 ||
      uri == null ||
      uri.scheme != 'https' ||
      uri.host != 'store.steampowered.com' ||
      uri.userInfo.isNotEmpty ||
      (uri.hasPort && uri.port != 443) ||
      uri.hasQuery ||
      uri.hasFragment) {
    throw const RepositoryException(
      'Use an HTTPS store.steampowered.com/app/ link without credentials, query, or fragment (max 2048 characters).',
    );
  }
  final match = RegExp(r'^/app/([1-9]\d*)(?:/[A-Za-z0-9_-]+)?/?$')
      .firstMatch(uri.path);
  if (match == null) {
    throw const RepositoryException(
      'Only base-game /app/ links are supported. Bundles and subscriptions are unsupported.',
    );
  }
  return match.group(1)!;
}

bool isSafePurchaseUrl(Uri url) =>
    url.scheme == 'https' &&
    url.host == 'www.cheapshark.com' &&
    !url.hasPort &&
    url.userInfo.isEmpty &&
    url.path == '/redirect' &&
    !url.hasFragment &&
    url.queryParametersAll.length == 1 &&
    url.queryParametersAll['dealID']?.length == 1 &&
    (url.queryParameters['dealID']?.isNotEmpty ?? false);
