import 'package:flutter_test/flutter_test.dart';

import 'package:kernel_app/kernel_app.dart';

void main() {
  test('ServiceLocator resolves registered singleton', () {
    final locator = ServiceLocator();
    locator.registerSingleton<int>(42);
    expect(locator.get<int>(), 42);
  });
}
