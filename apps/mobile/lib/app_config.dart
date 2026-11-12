import 'package:flutter/foundation.dart' show kReleaseMode;

enum DataSource { sample, api }

class AppConfig {
  const AppConfig.sample() : source = DataSource.sample, apiBaseUrl = '';
  const AppConfig.api(this.apiBaseUrl) : source = DataSource.api;
  final DataSource source;
  final String apiBaseUrl;

  factory AppConfig.fromEnvironment() => AppConfig.fromBuildValues(
    source: const bool.hasEnvironment('DATA_SOURCE')
        ? const String.fromEnvironment('DATA_SOURCE')
        : null,
    apiBaseUrl: const bool.hasEnvironment('API_BASE_URL')
        ? const String.fromEnvironment('API_BASE_URL')
        : null,
    isRelease: kReleaseMode,
  );
  factory AppConfig.fromValues({
    required String source,
    String apiBaseUrl = '',
    bool isRelease = false,
  }) {
    if (isRelease && source == 'sample') {
      throw ArgumentError('Sample mode is unavailable in release builds.');
    }
    return switch (source) {
      'sample' => const AppConfig.sample(),
      'api' => AppConfig.api(apiBaseUrl),
      _ => throw ArgumentError(
        'DATA_SOURCE must be sample or api. No data source was started.',
      ),
    };
  }

  factory AppConfig.fromBuildValues({
    String? source,
    String? apiBaseUrl,
    required bool isRelease,
  }) => AppConfig.fromValues(
    source: source ?? (isRelease ? 'api' : 'sample'),
    apiBaseUrl:
        apiBaseUrl ??
        (isRelease
            ? 'https://largeproject.cop4331cfall26jo.com'
            : 'http://10.0.2.2:4000'),
    isRelease: isRelease,
  );
}
