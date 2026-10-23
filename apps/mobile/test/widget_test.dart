import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:price_tracker/api.dart';
import 'package:price_tracker/main.dart';

void main() {
  testWidgets(
    'starter checks shared API and distinguishes database readiness',
    (tester) async {
      final response = Completer<http.Response>();
      final client = MockClient((request) {
        expect(request.url.toString(), 'http://10.0.2.2:4000/api/health');

        return response.future;
      });

      addTearDown(client.close);
      await tester.pumpWidget(PriceTrackerApp(api: HealthApi(client: client)));

      expect(find.textContaining('not implemented yet'), findsOneWidget);
      expect(find.text('Not checked yet.'), findsOneWidget);

      await tester.tap(find.text('Check API'));
      await tester.pump();

      // Keep the request pending to verify that another check cannot start yet.
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );

      response.complete(
        http.Response(
          '{"status":"ok","service":"price-tracker-api","database":"not_configured"}',
          200,
        ),
      );

      await tester.pumpAndSettle();

      expect(find.textContaining('API is online'), findsOneWidget);
      expect(find.textContaining('Persistence is not ready'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNotNull,
      );
    },
  );

  testWidgets('unreachable API reports an actionable error', (tester) async {
    final client = MockClient(
      (_) async => throw http.ClientException('offline'),
    );

    addTearDown(client.close);
    await tester.pumpWidget(PriceTrackerApp(api: HealthApi(client: client)));

    await tester.tap(find.text('Check API'));
    await tester.pumpAndSettle();

    expect(find.textContaining('Could not reach the API'), findsOneWidget);
    expect(find.textContaining('API is online'), findsNothing);
  });

  test('rejects non-success and malformed health responses', () async {
    for (final response in [
      http.Response('{}', 200),
      http.Response('unavailable', 503),
    ]) {
      final client = MockClient((_) async => response);

      addTearDown(client.close);

      await expectLater(
        HealthApi(client: client).getHealth(),
        throwsFormatException,
      );
    }
  });

  test('rejects invalid API origins', () {
    final client = MockClient((_) async => http.Response('{}', 200));

    addTearDown(client.close);

    expect(
      () => HealthApi(client: client, baseUrl: 'file:///etc/passwd'),
      throwsArgumentError,
    );

    expect(
      () =>
          HealthApi(client: client, baseUrl: 'https://user:secret@example.com'),
      throwsArgumentError,
    );
  });
}
