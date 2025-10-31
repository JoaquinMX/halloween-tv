import 'package:meta/meta.dart';

import 'failure.dart';

/// Immutable runtime settings loaded from an adapter.
@immutable
class AppSettings {
  const AppSettings({this.effectsEnabled = true, this.allowHighResolution = false});

  final bool effectsEnabled;
  final bool allowHighResolution;
}

/// Port for retrieving runtime configuration.
abstract class SettingsPort {
  Future<AppSettings> load();
}

/// Failure thrown when settings cannot be loaded.
class SettingsLoadFailure extends SettingsFailure {
  const SettingsLoadFailure(String message, {Object? cause, StackTrace? stackTrace})
      : super(message, cause: cause, stackTrace: stackTrace);
}
