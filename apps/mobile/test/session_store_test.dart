import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:price_tracker/client/session_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('secure adapter round trips and deletes only its session key', () async {
    FlutterSecureStorage.setMockInitialValues({'unrelated': 'keep'});
    final store = SecureSessionStore();
    expect(await store.read(), isNull);
    await store.write('fixture-session');
    expect(await store.read(), 'fixture-session');
    await store.clear();
    expect(await store.read(), isNull);
    expect(await const FlutterSecureStorage().read(key: 'unrelated'), 'keep');
  });
}
