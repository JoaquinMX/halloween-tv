import 'package:logging/logging.dart';

/// Provides a lazily initialised global logger tree for the app.
class AppLogger {
  AppLogger._();

  static bool _initialised = false;

  /// Ensures logging is configured with a standard formatter.
  static void ensureInitialised({Level level = Level.INFO}) {
    if (_initialised) {
      return;
    }
    Logger.root
      ..level = level
      ..onRecord.listen((record) {
        final String message = record.message;
        final String formatted =
            '[${record.level.name}] ${record.loggerName}: $message';
        // ignore: avoid_print
        print(formatted);
        if (record.error != null) {
          // ignore: avoid_print
          print('  error: ${record.error}');
        }
        if (record.stackTrace != null) {
          // ignore: avoid_print
          print(record.stackTrace);
        }
      });
    _initialised = true;
  }

  /// Returns a child logger.
  static Logger create(String name) {
    ensureInitialised();
    return Logger(name);
  }
}
