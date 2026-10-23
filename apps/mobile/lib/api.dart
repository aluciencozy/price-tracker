import 'dart:convert';

import 'package:http/http.dart' as http;

const _defaultBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://10.0.2.2:4000',
);

class Health {
  const Health({required this.database});

  final String database;
}

class HealthApi {
  HealthApi({required this.client, String baseUrl = _defaultBaseUrl})
    : _baseUrl = Uri.parse(baseUrl) {
    // Paths are resolved below, so configuration must contain only the API origin.
    if (!['http', 'https'].contains(_baseUrl.scheme) ||
        _baseUrl.host.isEmpty ||
        _baseUrl.userInfo.isNotEmpty ||
        _baseUrl.hasQuery ||
        _baseUrl.hasFragment ||
        !['', '/'].contains(_baseUrl.path)) {
      throw ArgumentError(
        'API_BASE_URL must be an HTTP(S) origin without credentials.',
      );
    }
  }

  final http.Client client;
  final Uri _baseUrl;

  Future<Health> getHealth() async {
    final response = await client
        .get(_baseUrl.resolve('/api/health'))
        .timeout(const Duration(seconds: 5));

    if (response.statusCode != 200) {
      throw const FormatException('API unavailable');
    }

    final data = jsonDecode(response.body);

    // Do not treat a proxy page or an unexpected JSON response as a healthy API.
    if (data is! Map<String, dynamic> ||
        data['status'] != 'ok' ||
        data['service'] != 'price-tracker-api' ||
        ![
          'not_configured',
          'connecting',
          'connected',
          'disconnected',
        ].contains(data['database'])) {
      throw const FormatException('Unexpected API health response');
    }

    return Health(database: data['database'] as String);
  }
}
