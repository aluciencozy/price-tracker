import 'package:flutter/material.dart';

class TrackerAppScope extends InheritedWidget {
  const TrackerAppScope({
    super.key,
    required this.sample,
    required super.child,
    this.accountBuilder,
  });
  final bool sample;
  final WidgetBuilder? accountBuilder;
  static TrackerAppScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<TrackerAppScope>();
  static bool isSample(BuildContext context) =>
      maybeOf(context)?.sample ?? true;
  @override
  bool updateShouldNotify(TrackerAppScope oldWidget) =>
      oldWidget.sample != sample || oldWidget.accountBuilder != accountBuilder;
}
