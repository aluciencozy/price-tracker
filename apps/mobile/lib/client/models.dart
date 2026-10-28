typedef Json = Map<String, dynamic>;

Never invalidJson() => throw const FormatException('Unexpected API response');
Json jsonObject(Object? value) => value is Json ? value : invalidJson();
void requireKeys(Json json, List<String> keys) {
  if (json.length != keys.length || keys.any((key) => !json.containsKey(key))) {
    invalidJson();
  }
}

String jsonString(Object? value, [int max = 8192]) =>
    value is String && value.isNotEmpty && value.length <= max
    ? value
    : invalidJson();
String? nullableString(Object? value, [int max = 8192]) =>
    value == null ? null : jsonString(value, max);
String jsonId(Object? value) {
  final id = jsonString(value, 128);
  if (!RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(id)) invalidJson();
  return id;
}

bool jsonBool(Object? value) => value is bool ? value : invalidJson();
int jsonInteger(Object? value, [int max = 9007199254740991]) =>
    value is int && value >= 0 && value <= max ? value : invalidJson();
DateTime jsonTime(Object? value) {
  final input = jsonString(value);
  final match = RegExp(
    r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$',
  ).firstMatch(input);
  if (match == null) invalidJson();
  final parts = [for (var i = 1; i <= 6; i++) int.parse(match.group(i)!)];
  final local = DateTime.utc(
    parts[0],
    parts[1],
    parts[2],
    parts[3],
    parts[4],
    parts[5],
  );
  final normalized = [
    local.year,
    local.month,
    local.day,
    local.hour,
    local.minute,
    local.second,
  ];
  // Dart normalizes impossible dates; the API requires an actual UTC timestamp.
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] != normalized[i]) invalidJson();
  }
  return DateTime.tryParse(input) ?? invalidJson();
}

DateTime? nullableTime(Object? value) => value == null ? null : jsonTime(value);
List<T> jsonList<T>(Object? value, T Function(Json) parse, [int max = 100]) =>
    value is List && value.length <= max
    ? List.unmodifiable(value.map((entry) => parse(jsonObject(entry))))
    : invalidJson();

class Money {
  Money(this.amountMinor) {
    jsonInteger(amountMinor);
  }
  final int amountMinor;
  String get currency => 'USD';
  factory Money.fromJson(Json json) {
    requireKeys(json, ['amountMinor', 'currency']);
    if (json['currency'] != 'USD') invalidJson();
    return Money(jsonInteger(json['amountMinor']));
  }
  Json toJson() => {'amountMinor': amountMinor, 'currency': currency};
}

class User {
  User.fromJson(Json json)
    : id = jsonId(json['id']),
      email = jsonString(json['email'], 254),
      name = nullableString(json['name'], 100),
      role = jsonString(json['role']),
      createdAt = jsonTime(json['createdAt']) {
    requireKeys(json, [
      'id',
      'email',
      'name',
      'emailVerified',
      'role',
      'createdAt',
    ]);
    if (json['emailVerified'] != true ||
        !['user', 'admin'].contains(role) ||
        !RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(email)) {
      invalidJson();
    }
  }
  final String id, email, role;
  final String? name;
  final DateTime createdAt;
  Json toJson() => {
    'id': id,
    'email': email,
    'name': name,
    'emailVerified': true,
    'role': role,
    'createdAt': createdAt.toIso8601String(),
  };
}

class Session {
  Session.fromJson(Json json)
    : accessToken = jsonString(json['accessToken']),
      expiresAt = jsonTime(json['expiresAt']),
      sessionId = jsonId(json['sessionId']),
      user = User.fromJson(jsonObject(json['user'])) {
    requireKeys(json, [
      'accessToken',
      'tokenType',
      'expiresIn',
      'expiresAt',
      'sessionId',
      'user',
    ]);
    if (json['tokenType'] != 'Bearer' ||
        json['expiresIn'] is! int ||
        json['expiresIn'] != 604800 ||
        !RegExp(r'^[A-Za-z0-9._~+/-]+=*$').hasMatch(accessToken)) {
      invalidJson();
    }
  }
  final String accessToken, sessionId;
  final DateTime expiresAt;
  final User user;
  bool expired(DateTime now) => !expiresAt.isAfter(now);
  Json toJson() => {
    'accessToken': accessToken,
    'tokenType': 'Bearer',
    'expiresIn': 604800,
    'expiresAt': expiresAt.toIso8601String(),
    'sessionId': sessionId,
    'user': user.toJson(),
  };
}

class Alerts {
  const Alerts({required this.email, required this.push});
  factory Alerts.fromJson(Json json) {
    requireKeys(json, ['email', 'push']);
    return Alerts(email: jsonBool(json['email']), push: jsonBool(json['push']));
  }
  final bool email, push;
  Json toJson() => {'email': email, 'push': push};
}

class OfferIdentity {
  OfferIdentity.fromJson(Json json)
    : providerGameId = jsonString(json['providerGameId'], 32) {
    requireKeys(json, [
      'provider',
      'providerGameId',
      'storeId',
      'market',
      'currency',
    ]);
    if (json['provider'] != 'cheapshark' ||
        json['storeId'] != '1' ||
        json['market'] != 'US' ||
        json['currency'] != 'USD' ||
        !RegExp(r'^[1-9][0-9]*$').hasMatch(providerGameId)) {
      invalidJson();
    }
  }
  final String providerGameId;
  String get provider => 'cheapshark';
  String get storeId => '1';
  String get market => 'US';
  String get currency => 'USD';
}

class Source {
  Source.fromJson(Json json)
    : name = jsonString(json['name']),
      url = jsonString(json['url']),
      attribution = jsonString(json['attribution']) {
    requireKeys(json, ['name', 'url', 'attribution']);
    if (name != 'CheapShark' ||
        url != 'https://www.cheapshark.com/' ||
        attribution !=
            'Prices supplied by CheapShark; Steam US/USD base-game offer, excluding taxes and checkout adjustments.') {
      invalidJson();
    }
  }
  final String name, url, attribution;
}

class ProductError {
  ProductError.fromJson(Json json)
    : code = jsonString(json['code']),
      message = jsonString(json['message'], 500),
      occurredAt = jsonTime(json['occurredAt']),
      retryAt = nullableTime(json['retryAt']) {
    requireKeys(json, ['code', 'message', 'occurredAt', 'retryAt']);
    if (![
      'PROVIDER_RATE_LIMITED',
      'PROVIDER_UNAVAILABLE',
      'STEAM_OFFER_UNAVAILABLE',
      'INVALID_PROVIDER_DATA',
      'UNSUPPORTED_PRODUCT',
    ].contains(code)) {
      invalidJson();
    }
  }
  final String code, message;
  final DateTime occurredAt;
  final DateTime? retryAt;
}

class Product {
  Product.fromJson(Json json)
    : id = jsonId(json['id']),
      identity = OfferIdentity.fromJson(jsonObject(json['identity'])),
      steamAppId = jsonString(json['steamAppId'], 32),
      canonicalSteamUrl = jsonString(json['canonicalSteamUrl'], 200),
      title = jsonString(json['title'], 300),
      storeName = jsonString(json['storeName']),
      imageUrl = nullableString(json['imageUrl'], 2048),
      source = Source.fromJson(jsonObject(json['source'])),
      currentPrice = json['currentPrice'] == null
          ? null
          : Money.fromJson(jsonObject(json['currentPrice'])),
      retailPrice = json['retailPrice'] == null
          ? null
          : Money.fromJson(jsonObject(json['retailPrice'])),
      dealId = nullableString(json['dealId'], 1024),
      purchaseUrl = nullableString(json['purchaseUrl'], 4096),
      observedAt = nullableTime(json['observedAt']),
      providerChangedAt = nullableTime(json['providerChangedAt']),
      freshness = jsonString(json['freshness']),
      staleAt = nullableTime(json['staleAt']),
      lastAttemptAt = nullableTime(json['lastAttemptAt']),
      nextCheckAt = nullableTime(json['nextCheckAt']),
      lastError = json['lastError'] == null
          ? null
          : ProductError.fromJson(jsonObject(json['lastError'])) {
    requireKeys(json, [
      'id',
      'identity',
      'steamAppId',
      'canonicalSteamUrl',
      'title',
      'storeName',
      'imageUrl',
      'source',
      'currentPrice',
      'retailPrice',
      'dealId',
      'purchaseUrl',
      'observedAt',
      'providerChangedAt',
      'freshness',
      'staleAt',
      'lastAttemptAt',
      'nextCheckAt',
      'lastError',
    ]);
    if (!RegExp(r'^[1-9][0-9]*$').hasMatch(steamAppId) ||
        storeName != 'Steam' ||
        canonicalSteamUrl !=
            'https://store.steampowered.com/app/$steamAppId/' ||
        !['fresh', 'stale', 'unavailable'].contains(freshness)) {
      invalidJson();
    }
    if (imageUrl != null) {
      final uri = Uri.tryParse(imageUrl!);
      if (uri == null ||
          uri.scheme != 'https' ||
          uri.host.isEmpty ||
          uri.userInfo.isNotEmpty) {
        invalidJson();
      }
    }
    if ((dealId == null) != (purchaseUrl == null) ||
        (dealId != null &&
            purchaseUrl !=
                'https://www.cheapshark.com/redirect?dealID=${Uri.encodeComponent(dealId!)}')) {
      invalidJson();
    }
    if (freshness == 'unavailable') {
      if ([
        currentPrice,
        retailPrice,
        observedAt,
        providerChangedAt,
        staleAt,
        dealId,
        purchaseUrl,
      ].any((value) => value != null)) {
        invalidJson();
      }
    } else {
      if (currentPrice == null || observedAt == null || staleAt == null) {
        invalidJson();
      }
      if (!staleAt!.isAtSameMomentAs(
        observedAt!.add(const Duration(hours: 24)),
      )) {
        invalidJson();
      }
      if (freshness == 'fresh' &&
          (lastAttemptAt == null || lastError != null || dealId == null)) {
        invalidJson();
      }
    }
  }
  final String id, steamAppId, canonicalSteamUrl, title, storeName, freshness;
  final OfferIdentity identity;
  final String? imageUrl, dealId, purchaseUrl;
  final Source source;
  final Money? currentPrice, retailPrice;
  final DateTime? observedAt,
      providerChangedAt,
      staleAt,
      lastAttemptAt,
      nextCheckAt;
  final ProductError? lastError;
}

class ProductPreview {
  ProductPreview.fromJson(Json json)
    : id = jsonId(json['id']),
      expiresAt = jsonTime(json['expiresAt']),
      product = Product.fromJson(jsonObject(json['product'])) {
    requireKeys(json, ['id', 'expiresAt', 'product']);
  }
  final String id;
  final DateTime expiresAt;
  final Product product;
}

class TrackedItem {
  TrackedItem.fromJson(Json json)
    : id = jsonId(json['id']),
      product = Product.fromJson(jsonObject(json['product'])),
      targetPrice = Money.fromJson(jsonObject(json['targetPrice'])),
      enabled = jsonBool(json['enabled']),
      alerts = Alerts.fromJson(jsonObject(json['alerts'])),
      createdAt = jsonTime(json['createdAt']),
      updatedAt = jsonTime(json['updatedAt']) {
    requireKeys(json, [
      'id',
      'product',
      'targetPrice',
      'enabled',
      'alerts',
      'createdAt',
      'updatedAt',
    ]);
  }
  final String id;
  final Product product;
  final Money targetPrice;
  final bool enabled;
  final Alerts alerts;
  final DateTime createdAt, updatedAt;
}

class Page<T> {
  Page.fromJson(Json json, T Function(Json) parse)
    : items = jsonList(json['items'], parse),
      limit = jsonInteger(jsonObject(json['page'])['limit'], 100),
      nextCursor = nullableString(
        jsonObject(json['page'])['nextCursor'],
        2048,
      ) {
    requireKeys(jsonObject(json['page']), ['limit', 'nextCursor']);
    if (limit == 0 || items.length > limit) invalidJson();
  }
  final List<T> items;
  final int limit;
  final String? nextCursor;
}

class Observation {
  Observation.fromJson(Json json)
    : id = jsonId(json['id']),
      price = Money.fromJson(jsonObject(json['price'])),
      observedAt = jsonTime(json['observedAt']),
      providerChangedAt = nullableTime(json['providerChangedAt']) {
    requireKeys(json, ['id', 'price', 'observedAt', 'providerChangedAt']);
  }
  final String id;
  final Money price;
  final DateTime observedAt;
  final DateTime? providerChangedAt;
}

class History {
  History.fromJson(Json json)
    : trackedItemId = jsonId(json['trackedItemId']),
      product = Product.fromJson(jsonObject(json['product'])),
      from = jsonTime(jsonObject(json['window'])['from']),
      to = jsonTime(jsonObject(json['window'])['to']),
      retainedFrom = jsonTime(json['retainedFrom']),
      page = Page.fromJson(json, Observation.fromJson) {
    requireKeys(json, [
      'trackedItemId',
      'product',
      'window',
      'retainedFrom',
      'items',
      'page',
    ]);
    requireKeys(jsonObject(json['window']), ['from', 'to']);
    if (!from.isBefore(to) || to.difference(from) > const Duration(days: 90)) {
      invalidJson();
    }
  }
  final String trackedItemId;
  final Product product;
  final DateTime from, to, retainedFrom;
  final Page<Observation> page;
}
