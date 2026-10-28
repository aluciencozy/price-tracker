import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:price_tracker/main.dart';
import 'package:price_tracker/sample_repository.dart';
import 'package:price_tracker/screens.dart';
import 'package:price_tracker/theme.dart';

Future<void> tapText(WidgetTester tester, String text) async {
  final finder = find.text(text);
  if (finder.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      finder,
      250,
      maxScrolls: 30,
      scrollable: find
          .byWidgetPredicate(
            (widget) =>
                widget is Scrollable &&
                widget.axisDirection == AxisDirection.down,
          )
          .first,
    );
  } else {
    await tester.ensureVisible(finder);
  }
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Future<void> start(WidgetTester tester, SampleTrackerRepository repo) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(430, 1000);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(PriceTrackerApp(repository: repo));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'forced light theme, local type, honest labels and async loading',
    (tester) async {
      tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
      addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
      await tester.pumpWidget(
        PriceTrackerApp(repository: SampleTrackerRepository()),
      );
      expect(find.text('Loading sample watchlist…'), findsOneWidget);
      await tester.pumpAndSettle();
      expect(find.text(sampleNotice), findsOneWidget);
      expect(find.text('Portal 2'), findsOneWidget);
      final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
      expect(app.themeMode, ThemeMode.light);
      expect(
        Theme.of(tester.element(find.text('Portal 2'))).brightness,
        Brightness.light,
      );
      expect(app.theme!.textTheme.bodyMedium!.fontFamily, 'JetBrainsMono');
      expect(palette.onPrimary, palette.onSurface);
      expect(palette.onPrimary.computeLuminance(), lessThan(.02));
      expect(find.text('Check API'), findsNothing);
      expect(find.textContaining('Check Prices Now'), findsNothing);
    },
  );
  testWidgets('search, no results, details and clearly illustrative history', (
    tester,
  ) async {
    final repo = SampleTrackerRepository(delay: Duration.zero);
    await start(tester, repo);
    await tester.enterText(find.byType(TextField), 'not a game');
    await tester.pumpAndSettle();
    expect(find.text('No saved games match.'), findsOneWidget);
    await tapText(tester, 'Clear search');
    await tester.enterText(find.byType(TextField), 'portal');
    await tester.pumpAndSettle();
    expect(find.text('Half-Life 2'), findsNothing);
    await tapText(tester, 'Portal 2');
    expect(find.text('Game details'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Illustrative sample history'),
      250,
    );
    expect(find.text('Illustrative sample history'), findsOneWidget);
    await tester.scrollUntilVisible(find.textContaining('2026-10-24'), 200);
    expect(find.textContaining('\$12.99 USD'), findsOneWidget);
    expect((await repo.list()).first.targetPrice.amountMinor, 499);
  });
  testWidgets(
    'URL preview then valid zero target and independent preferences save',
    (tester) async {
      final repo = SampleTrackerRepository(delay: Duration.zero)
        ..reset(empty: true);
      await start(tester, repo);
      expect(find.text('Your next game starts here.'), findsOneWidget);
      await tapText(tester, 'Add game');
      await tapText(tester, 'Use Portal 2 link');
      await tapText(tester, 'Preview game');
      expect(find.text('Portal 2'), findsOneWidget);
      await tester.enterText(find.byType(TextField), '0');
      await tapText(tester, 'Tracking enabled');
      await tapText(tester, 'Email preference');
      await tapText(tester, 'Android push preference');
      await tapText(tester, 'Save tracker');
      expect(find.text('Watchlist'), findsOneWidget);
      final saved = (await repo.list()).single;
      expect(saved.targetPrice.amountMinor, 0);
      expect(saved.enabled, false);
      expect(saved.alerts.email, false);
      expect(saved.alerts.push, true);
    },
  );
  testWidgets(
    'invalid URL/target and duplicate save explain failures; cancel changes nothing',
    (tester) async {
      final repo = SampleTrackerRepository(delay: Duration.zero);
      await start(tester, repo);
      await tapText(tester, 'Add game');
      await tester.enterText(
        find.byType(TextField),
        'https://store.steampowered.com/bundle/620/',
      );
      await tapText(tester, 'Preview game');
      expect(
        find.textContaining('Bundles and subscriptions are unsupported.'),
        findsOneWidget,
      );
      await tapText(tester, 'Use Portal 2 link');
      await tapText(tester, 'Preview game');
      await tester.enterText(find.byType(TextField), '-1');
      await tapText(tester, 'Save tracker');
      expect(find.textContaining('Enter a USD amount'), findsOneWidget);
      await tester.ensureVisible(find.byType(TextField));
      await tester.enterText(find.byType(TextField), '4.99');
      await tapText(tester, 'Save tracker');
      expect(find.textContaining('already in your watchlist'), findsOneWidget);
      await tapText(tester, 'Cancel');
      expect((await repo.list()).length, 2);
    },
  );
  testWidgets(
    'edit changes target not source price; removal requires confirmation',
    (tester) async {
      final repo = SampleTrackerRepository(delay: Duration.zero);
      await start(tester, repo);
      await tapText(tester, 'Portal 2');
      await tapText(tester, 'Edit target and preferences');
      await tester.enterText(find.byType(TextField), '20');
      await tapText(tester, 'Save changes');
      final updated = (await repo.list()).first;
      expect(updated.targetPrice.amountMinor, 2000);
      expect(updated.product.price!.amountMinor, 999);
      await tapText(tester, 'Remove tracker');
      expect(find.text('Remove tracker?'), findsOneWidget);
      await tapText(tester, 'Keep tracker');
      expect((await repo.list()).length, 2);
      await tapText(tester, 'Remove tracker');
      await tapText(tester, 'Remove');
      expect(find.text('Watchlist'), findsOneWidget);
      expect((await repo.list()).length, 1);
    },
  );
  testWidgets('offline load and expired session offer useful recovery', (
    tester,
  ) async {
    final repo = SampleTrackerRepository(delay: Duration.zero)
      ..scenario = SampleScenario.offline;
    await start(tester, repo);
    expect(find.textContaining('Sample offline state.'), findsOneWidget);
    repo.scenario = SampleScenario.normal;
    await tapText(tester, 'Try again');
    expect(find.text('Portal 2'), findsOneWidget);
    await tester.tap(find.byTooltip('Account and settings'));
    await tester.pumpAndSettle();
    await tapText(tester, 'Sample developer scenarios');
    await tapText(tester, 'Expired session');
    expect(find.textContaining('Sample session expired.'), findsOneWidget);
    await tapText(tester, 'Go to account');
    expect(find.text('Account and settings'), findsOneWidget);
  });
  testWidgets(
    'failed save retains draft; missing price never renders zero or purchase',
    (tester) async {
      final repo = SampleTrackerRepository(delay: Duration.zero);
      await start(tester, repo);
      await tapText(tester, 'Portal 2');
      await tapText(tester, 'Edit target and preferences');
      await tester.enterText(find.byType(TextField), '0');
      repo.scenario = SampleScenario.offline;
      await tapText(tester, 'Save changes');
      expect(find.textContaining('Nothing was changed.'), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        '0',
      );
      repo.scenario = SampleScenario.normal;
      expect((await repo.list()).first.targetPrice.amountMinor, 499);
      await tapText(tester, 'Cancel');
      await tester.pageBack();
      await tester.pumpAndSettle();
      repo.scenario = SampleScenario.missingOffer;
      await tapText(tester, 'Portal 2');
      expect(find.text('Steam price unavailable'), findsOneWidget);
      expect(find.textContaining('\$0.00'), findsNothing);
      expect(find.text('View purchase link'), findsNothing);
    },
  );
  testWidgets(
    'account preview explains browser handoff and never collects credentials',
    (tester) async {
      await start(tester, SampleTrackerRepository(delay: Duration.zero));
      await tester.tap(find.byTooltip('Account and settings'));
      await tester.pumpAndSettle();
      await tapText(tester, 'Preview account flows');
      for (final field in tester.widgetList<TextField>(
        find.byType(TextField),
      )) {
        expect(field.readOnly, true);
        expect(field.controller, isNull);
      }
      await tapText(tester, 'Preview unverified account');
      expect(
        find.textContaining('Login is blocked until verification.'),
        findsOneWidget,
      );
      await tapText(tester, 'Verify email');
      expect(
        find.textContaining('No deep link or automatic login'),
        findsOneWidget,
      );
      await tapText(tester, 'Preview expired link');
      expect(find.textContaining('Expired-link preview'), findsOneWidget);
      await tapText(tester, 'Reset password');
      expect(
        find.textContaining('Password reset finishes in your browser.'),
        findsOneWidget,
      );
      expect(find.byType(TextField), findsNothing);
      expect(find.text(sampleNotice), findsOneWidget);
    },
  );
  testWidgets('320px and 200% text remain scrollable without overflow', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(320, 740);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: appTheme(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
        home: WatchlistScreen(
          repository: SampleTrackerRepository(delay: Duration.zero),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tapText(tester, 'Portal 2');
    expect(tester.takeException(), isNull);
    await tapText(tester, 'Edit target and preferences');
    await tapText(tester, 'Android push preference');
    expect(tester.takeException(), isNull);
    await tapText(tester, 'Cancel');
    await tapText(tester, 'Remove tracker');
    expect(tester.takeException(), isNull);
    await tapText(tester, 'Keep tracker');
    expect(tester.takeException(), isNull);
  });
}
