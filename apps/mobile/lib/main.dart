import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'api.dart';
import 'app_config.dart';
import 'app_scope.dart';
import 'client/mobile_api.dart';
import 'client/session_controller.dart';
import 'client/session_store.dart';
import 'live_account.dart';
import 'live_session_host.dart';
import 'push/integration.dart';
import 'push/registration.dart';
import 'push/storage.dart';
import 'push/firebase_gateway.dart';
import 'sample_repository.dart';
import 'screens.dart';
import 'theme.dart';
import 'tracker_repository.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  FirebasePushGateway? gateway;
  final dispatcher = PushEventDispatcher();
  try {
    final config = AppConfig.fromEnvironment();
    final push = FirebasePushConfig.environment();
    if (config.source == DataSource.api && push.configured) {
      final candidate = FirebasePushGateway(push, dispatcher);
      if (candidate.supported) {
        gateway = candidate;
        // Permission synchronization initializes lazily only after a verified
        // API session exists. Invalid API config cannot initialize Firebase.
      }
    }
  } on ArgumentError {
    /* The application renders its configuration error. */
  }
  runApp(
    PriceTrackerApp(
      pushGateway: gateway ?? const UnconfiguredPushGateway(),
      pushStorage: gateway?.storage,
      pushDispatcher: dispatcher,
    ),
  );
}

class PriceTrackerApp extends StatefulWidget {
  const PriceTrackerApp({
    super.key,
    this.repository,
    this.api,
    this.config,
    this.client,
    this.sessionStore,
    this.mobileApi,
    this.accountStatusBuilder,
    this.sessionIntegrationBuilder,
    this.pushGateway = const UnconfiguredPushGateway(),
    this.pushStorage,
    this.pushDispatcher,
  });
  final TrackerRepository? repository;
  final HealthApi? api;
  final AppConfig? config;
  final http.Client? client;
  final SessionStore? sessionStore;
  final MobileApi? mobileApi;
  final AccountStatusBuilder? accountStatusBuilder;
  final SessionIntegrationBuilder? sessionIntegrationBuilder;
  final PushPermissionGateway pushGateway;
  final PushStorage? pushStorage;
  final PushEventDispatcher? pushDispatcher;
  @override
  State<PriceTrackerApp> createState() => _PriceTrackerAppState();
}

class _PriceTrackerAppState extends State<PriceTrackerApp> {
  TrackerRepository? _repository;
  SessionController? _session;
  MobileApi? _mobile;
  http.Client? _ownedClient;
  String? _configurationError;
  @override
  void initState() {
    super.initState();
    try {
      final config = widget.config ?? AppConfig.fromEnvironment();
      if (config.source == DataSource.sample) {
        _repository = widget.repository ?? SampleTrackerRepository();
      } else {
        final client =
            widget.client ??
            (widget.mobileApi == null
                ? (_ownedClient = http.Client())
                : widget.mobileApi!.client);
        _mobile =
            widget.mobileApi ??
            MobileApi(client: client, baseUrl: config.apiBaseUrl);
        _session = SessionController(
          api: _mobile!,
          store: widget.sessionStore ?? SecureSessionStore(),
        );
      }
    } catch (error) {
      if (error is! ArgumentError && error is! FormatException) rethrow;
      _configurationError = 'Price Tracker is unavailable. Please update the app or contact support.';
    }
  }

  @override
  void dispose() {
    _session?.dispose();
    _ownedClient?.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Price Tracker',
    debugShowCheckedModeBanner: false,
    theme: appTheme(),
    themeMode: ThemeMode.light,
    home: _configurationError != null
        ? Scaffold(
            body: SafeArea(child: Center(child: Text(_configurationError!))),
          )
        : _session != null
        ? Builder(
            builder: (context) {
              final host = LiveSessionHost(
                session: _session!,
                api: _mobile!,
                healthApi: widget.api,
                accountStatusBuilder: (context, session) => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const PushAccountStatus(),
                    if (widget.accountStatusBuilder != null)
                      widget.accountStatusBuilder!(context, session),
                  ],
                ),
              );
              final child =
                  widget.sessionIntegrationBuilder?.call(
                    context,
                    _session!,
                    host,
                  ) ??
                  host;
              return PushSessionIntegration(
                session: _session!,
                api: _mobile!,
                origin:
                    (widget.config ?? AppConfig.fromEnvironment()).apiBaseUrl,
                storage: widget.pushStorage,
                gateway: widget.pushGateway,
                dispatcher: widget.pushDispatcher,
                child: child,
              );
            },
          )
        : TrackerAppScope(
            sample: true,
            child: WatchlistScreen(repository: _repository!, api: widget.api),
          ),
  );
}
