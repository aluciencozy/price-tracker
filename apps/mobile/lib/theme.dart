import 'package:flutter/material.dart';

// Shared light palette. Dark foreground on teal is intentional for contrast.
const palette = ColorScheme.light(
  primary: Color(0xff00bba7),
  onPrimary: Color(0xff031a1e),
  primaryContainer: Color(0xffc3ecdf),
  onPrimaryContainer: Color(0xff006363),
  secondary: Color(0xffe4f2f2),
  onSecondary: Color(0xff031a1e),
  secondaryContainer: Color(0xffe4f2f2),
  onSecondaryContainer: Color(0xff031a1e),
  tertiary: Color(0xff006363),
  onTertiary: Colors.white,
  error: Color(0xffa51d32),
  onError: Colors.white,
  errorContainer: Color(0xffffe9ec),
  onErrorContainer: Color(0xff720d22),
  surface: Color(0xfff9fdff),
  onSurface: Color(0xff031a1e),
  surfaceContainerLowest: Colors.white,
  surfaceContainerLow: Color(0xffebf4f4),
  surfaceContainer: Color(0xffebf4f4),
  surfaceContainerHigh: Color(0xffe4f2f2),
  surfaceContainerHighest: Color(0xffe0eeee),
  onSurfaceVariant: Color(0xff50686d),
  outline: Color(0xff627b80),
  outlineVariant: Color(0xffdae3e4),
  shadow: Color(0xff183c48),
  inverseSurface: Color(0xff031a1e),
  onInverseSurface: Color(0xfff9fdff),
  inversePrimary: Color(0xff00bba7),
  surfaceTint: Colors.transparent,
);

ThemeData appTheme() {
  final shape = RoundedRectangleBorder(borderRadius: BorderRadius.circular(8));
  final border = OutlineInputBorder(borderRadius: BorderRadius.circular(8));
  return ThemeData(
    useMaterial3: true,
    colorScheme: palette,
    fontFamily: 'JetBrainsMono',
    scaffoldBackgroundColor: palette.surface,
    focusColor: palette.tertiary.withValues(alpha: .18),
    appBarTheme: AppBarTheme(
      backgroundColor: palette.surface,
      foregroundColor: palette.onSurface,
      scrolledUnderElevation: 0,
      centerTitle: false,
    ),
    cardTheme: CardThemeData(
      color: palette.surfaceContainerLowest,
      elevation: 1,
      shadowColor: palette.shadow.withValues(alpha: .10),
      margin: EdgeInsets.zero,
      shape: shape.copyWith(side: BorderSide(color: palette.outlineVariant)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      floatingLabelStyle: TextStyle(color: palette.tertiary),
      border: border,
      enabledBorder: border.copyWith(
        borderSide: BorderSide(color: palette.outline),
      ),
      focusedBorder: border.copyWith(
        borderSide: BorderSide(color: palette.tertiary, width: 2),
      ),
      filled: true,
      fillColor: palette.surfaceContainerLowest,
      contentPadding: const EdgeInsets.all(16),
    ),
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: palette.tertiary,
      selectionColor: palette.primaryContainer,
      selectionHandleColor: palette.tertiary,
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: palette.tertiary),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: palette.tertiary,
        minimumSize: const Size(48, 48),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: palette.tertiary,
        minimumSize: const Size(48, 48),
        shape: shape,
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(48, 48),
        shape: shape,
      ),
    ),
    floatingActionButtonTheme: FloatingActionButtonThemeData(
      backgroundColor: palette.primary,
      foregroundColor: palette.onPrimary,
      shape: shape,
    ),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith(
        (states) =>
            states.contains(WidgetState.selected) ? palette.onPrimary : null,
      ),
      trackOutlineColor: WidgetStatePropertyAll(palette.outline),
    ),
  );
}
