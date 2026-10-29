import 'package:flutter/material.dart';

import 'tracker_repository.dart';

class IllustrativeHistoryChart extends StatelessWidget {
  const IllustrativeHistoryChart({super.key, required this.observations});

  final List<Observation> observations;

  @override
  Widget build(BuildContext context) {
    if (observations.isEmpty) {
      return const Text('No observations available.');
    }
    final ordered = [...observations]
      ..sort((a, b) => a.observedAt.compareTo(b.observedAt));
    final highest = ordered.fold(
      0,
      (value, entry) =>
          entry.price.amountMinor > value ? entry.price.amountMinor : value,
    );
    // A zero-only series still needs a nonzero vertical range.
    final ceiling = highest == 0 ? 100 : highest;
    final first = ordered.first;
    final last = ordered.last;
    String day(Observation entry) =>
        entry.observedAt.toUtc().toIso8601String().substring(0, 10);
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('USD scale: ${Money(0).formatted} to ${Money(ceiling).formatted}'),
        const SizedBox(height: 8),
        Semantics(
          image: true,
          label:
              'Illustrative sample history chart. Invented values, not recorded Steam history. '
              '${ordered.length} sample ${ordered.length == 1 ? 'point' : 'points'}. From ${day(first)} at ${first.price.formatted} USD '
              'to ${day(last)} at ${last.price.formatted} USD. Dated values listed below.',
          child: SizedBox(
            width: double.infinity,
            height: 144,
            child: CustomPaint(
              painter: _HistoryPainter(
                ordered,
                ceiling,
                colors.tertiary,
                colors.outlineVariant,
              ),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text('${day(first)} to ${day(last)} (UTC)'),
      ],
    );
  }
}

class _HistoryPainter extends CustomPainter {
  _HistoryPainter(this.observations, this.ceiling, this.color, this.gridColor);

  final List<Observation> observations;
  final int ceiling;
  final Color color;
  final Color gridColor;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.width <= 16 || size.height <= 16) {
      return;
    }
    final plot = Rect.fromLTRB(8, 8, size.width - 8, size.height - 8);
    final grid = Paint()
      ..color = gridColor
      ..strokeWidth = 1;
    for (final y in [plot.top, plot.center.dy, plot.bottom]) {
      canvas.drawLine(Offset(plot.left, y), Offset(plot.right, y), grid);
    }
    final start = observations.first.observedAt.millisecondsSinceEpoch;
    final span = observations.last.observedAt.millisecondsSinceEpoch - start;
    final points = observations
        .map(
          (entry) => Offset(
            span == 0
                ? plot.center.dx
                : plot.left +
                      (entry.observedAt.millisecondsSinceEpoch - start) /
                          span *
                          plot.width,
            plot.bottom - entry.price.amountMinor / ceiling * plot.height,
          ),
        )
        .toList();
    if (points.length > 1) {
      final path = Path()..moveTo(points.first.dx, points.first.dy);
      for (final point in points.skip(1)) {
        path.lineTo(point.dx, point.dy);
      }
      canvas.drawPath(
        path,
        Paint()
          ..color = color
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2,
      );
    }
    final marker = Paint()..color = color;
    for (final point in points) {
      canvas.drawCircle(point, 4, marker);
    }
  }

  @override
  bool shouldRepaint(_HistoryPainter oldDelegate) =>
      oldDelegate.observations != observations ||
      oldDelegate.color != color ||
      oldDelegate.gridColor != gridColor;
}
