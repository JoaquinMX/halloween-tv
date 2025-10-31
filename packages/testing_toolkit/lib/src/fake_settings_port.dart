import 'package:core_foundation/core_foundation.dart';

class FakeSettingsPort implements SettingsPort {
  FakeSettingsPort(this._settings);

  AppSettings _settings;

  void update(AppSettings settings) {
    _settings = settings;
  }

  @override
  Future<AppSettings> load() async => _settings;
}
