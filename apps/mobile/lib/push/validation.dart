bool isPushId(String value) =>
    RegExp(r'^[A-Za-z0-9_-]{1,128}$').stringMatch(value) == value;

bool isInstallationId(String value) =>
    RegExp(r'^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$')
        .stringMatch(value) ==
    value;

DateTime parsePushTimestamp(String value) {
  final match = RegExp(
    r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$',
  ).firstMatch(value);
  final date = DateTime.tryParse(value);
  if (match == null ||
      match.end != value.length ||
      date == null ||
      !date.isUtc) {
    throw const FormatException('Expected a UTC timestamp');
  }
  // DateTime.parse otherwise normalizes invalid dates such as February 30.
  final parts = [
    date.year,
    date.month,
    date.day,
    date.hour,
    date.minute,
    date.second,
  ];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] != int.parse(match.group(i + 1)!)) {
      throw const FormatException('Invalid UTC timestamp');
    }
  }
  return date;
}
