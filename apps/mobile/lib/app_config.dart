enum DataSource { sample, api }

class AppConfig {
  const AppConfig.sample() : source = DataSource.sample, apiBaseUrl = '';
  const AppConfig.api(this.apiBaseUrl) : source = DataSource.api;
  final DataSource source;
  final String apiBaseUrl;

  factory AppConfig.fromEnvironment() => AppConfig.fromValues(
    source: const String.fromEnvironment('DATA_SOURCE', defaultValue: 'sample'),
    apiBaseUrl: const String.fromEnvironment(
      'API_BASE_URL',
      defaultValue: 'http://10.0.2.2:4000',
    ),
  );
  factory AppConfig.fromValues({
    required String source,
    String apiBaseUrl = '',
  }) => switch (source) {
    'sample' => const AppConfig.sample(),
    'api' => AppConfig.api(apiBaseUrl),
    _ => throw ArgumentError(
      'DATA_SOURCE must be sample or api. No data source was started.',
    ),
  };
}
