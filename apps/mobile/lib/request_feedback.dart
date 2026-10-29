import 'dart:async';

import 'package:flutter/material.dart';

import 'client/mobile_api.dart';
import 'tracker_repository.dart';

String requestMessage(Object error) {
  if (error is ApiFailure) {
    return [
      error.message,
      for (final field in error.fields) '${field.path}: ${field.message}',
    ].join('\n');
  }
  if (error is RepositoryException) return error.message;
  if (error is FormatException) return error.message;
  return 'The request could not be completed. Please try again.';
}

mixin RequestCooldown<T extends StatefulWidget> on State<T> {
  Timer? _retryTimer;
  int retrySeconds = 0;
  void coolDown(Object error) {
    final seconds = error is ApiFailure
        ? error.retryAfterSeconds
        : error is RepositoryException
        ? error.retryAfterSeconds
        : null;
    if (seconds == null || seconds < 1) return;
    _retryTimer?.cancel();
    retrySeconds = seconds;
    _retryTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      setState(() => retrySeconds = (seconds - timer.tick).clamp(0, seconds));
      if (retrySeconds == 0) timer.cancel();
    });
  }

  @override
  void dispose() {
    _retryTimer?.cancel();
    super.dispose();
  }
}
