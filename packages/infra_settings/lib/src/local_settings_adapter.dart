import 'package:core_foundation/core_foundation.dart';

/// Simple settings adapter that provides local defaults.
class LocalSettingsAdapter implements SettingsPort {
  const LocalSettingsAdapter({AppSettings settings = const AppSettings()}) : _settings = settings;

  final AppSettings _settings;

  @override
  Future<AppSettings> load() async => _settings;
}
