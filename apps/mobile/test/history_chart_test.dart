import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:price_tracker/history_chart.dart';
import 'package:price_tracker/theme.dart';
import 'package:price_tracker/tracker_repository.dart';

Observation point(int day, int cents) =>
    Observation(DateTime.utc(2026, 10, day), Money(cents));

Future<void> showChart(WidgetTester tester, List<Observation> observations) =>
    tester.pumpWidget(
      MaterialApp(
        theme: appTheme(),
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 280,
              child: IllustrativeHistoryChart(observations: observations),
            ),
          ),
        ),
      ),
    );

Finder get plot => find.descendant(
  of: find.byType(IllustrativeHistoryChart),
  matching: find.byType(CustomPaint),
);

void main() {
  testWidgets(
    'multi-day chart renders price points on a dated zero-based scale with honest semantics',
    (tester) async {
      final semantics = tester.ensureSemantics();
      // Unsorted input still plots dates chronologically with proportional time spacing.
      await showChart(tester, [point(28, 0), point(24, 1000), point(25, 500)]);
      expect(find.text('USD scale: \$0.00 to \$10.00'), findsOneWidget);
      expect(find.text('2026-10-24 to 2026-10-28 (UTC)'), findsOneWidget);
      expect(
        find.bySemanticsLabel(
          RegExp(
            'Illustrative sample history chart. Invented values, not recorded Steam history. 3 sample points.',
          ),
        ),
        findsOneWidget,
      );
      expect(
        tester.renderObject(plot),
        paints
          ..path(color: palette.tertiary, strokeWidth: 2)
          ..circle(x: 8, y: 8, radius: 4)
          ..circle(x: 74, y: 72, radius: 4)
          ..circle(x: 272, y: 136, radius: 4),
      );
      semantics.dispose();
    },
  );

  testWidgets(
    'empty history shows an honest empty state without a fake chart',
    (tester) async {
      await showChart(tester, []);
      expect(find.text('No observations available.'), findsOneWidget);
      expect(plot, findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'single free observation is a centered point at zero, not a fabricated line',
    (tester) async {
      final semantics = tester.ensureSemantics();
      await showChart(tester, [point(24, 0)]);
      expect(find.text('USD scale: \$0.00 to \$1.00'), findsOneWidget);
      expect(
        find.bySemanticsLabel(
          RegExp(r'1 sample point. From 2026-10-24 at \$0.00 USD'),
        ),
        findsOneWidget,
      );
      expect(
        tester.renderObject(plot),
        paints..circle(x: 140, y: 136, radius: 4),
      );
      expect(tester.renderObject(plot), isNot(paints..path()));
      expect(tester.takeException(), isNull);
      semantics.dispose();
    },
  );

  testWidgets('flat and all-zero series render finite horizontal points', (
    tester,
  ) async {
    for (final cents in [999, 0]) {
      await showChart(tester, [point(24, cents), point(26, cents)]);
      final y = cents == 0 ? 136.0 : 8.0;
      expect(
        tester.renderObject(plot),
        paints
          ..path(color: palette.tertiary)
          ..circle(x: 8, y: y, radius: 4)
          ..circle(x: 272, y: y, radius: 4),
      );
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets(
    'observations at the same timestamp stay centered without dividing by zero',
    (tester) async {
      await showChart(tester, [point(24, 999), point(24, 0)]);
      expect(
        tester.renderObject(plot),
        paints
          ..circle(x: 140, y: 8, radius: 4)
          ..circle(x: 140, y: 136, radius: 4),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'chart and scale labels fit narrow layouts with 200 percent text',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(320, 740);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          theme: appTheme(),
          home: MediaQuery(
            data: const MediaQueryData(textScaler: TextScaler.linear(2)),
            child: Scaffold(
              body: SingleChildScrollView(
                padding: const EdgeInsets.all(20),
                child: IllustrativeHistoryChart(
                  observations: [point(24, 1299), point(26, 999)],
                ),
              ),
            ),
          ),
        ),
      );
      expect(tester.getSize(plot).width, 280);
      expect(find.text('2026-10-24 to 2026-10-26 (UTC)'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}
