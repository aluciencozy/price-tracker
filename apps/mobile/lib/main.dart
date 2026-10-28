import 'package:flutter/material.dart';

import 'api.dart';
import 'sample_repository.dart';
import 'screens.dart';
import 'theme.dart';
import 'tracker_repository.dart';

void main() => runApp(const PriceTrackerApp());

class PriceTrackerApp extends StatefulWidget {
  const PriceTrackerApp({super.key, this.repository, this.api});
  final TrackerRepository? repository;
  final HealthApi? api;
  @override
  State<PriceTrackerApp> createState() => _PriceTrackerAppState();
}

class _PriceTrackerAppState extends State<PriceTrackerApp> {
  late final TrackerRepository _repository =
      widget.repository ?? SampleTrackerRepository();
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Price Tracker',
    debugShowCheckedModeBanner: false,
    theme: appTheme(),
    themeMode: ThemeMode.light,
    home: WatchlistScreen(repository: _repository, api: widget.api),
  );
}
