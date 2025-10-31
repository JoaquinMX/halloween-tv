import 'package:flutter_test/flutter_test.dart';

import 'package:infra_settings/infra_settings.dart';

void main() {
  test('LocalSettingsAdapter returns provided settings', () async {
    const settings = AppSettings(effectsEnabled: false, allowHighResolution: true);
    final adapter = LocalSettingsAdapter(settings: settings);
    expect(await adapter.load(), settings);
  });
}
