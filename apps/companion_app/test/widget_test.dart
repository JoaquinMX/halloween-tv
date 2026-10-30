import 'package:companion_app/src/companion_app.dart';
import 'package:companion_app/src/ui/join_screen.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('Companion boots to anonymous join form', (tester) async {
    SharedPreferences.setMockInitialValues({}); await tester.pumpWidget(const CompanionApp()); await tester.pumpAndSettle();
    expect(find.byKey(JoinScreen.partyFieldKey), findsOneWidget); expect(find.byKey(JoinScreen.channelFieldKey), findsOneWidget); expect(find.byKey(JoinScreen.pinFieldKey), findsOneWidget); expect(find.byKey(JoinScreen.submitKey), findsOneWidget);
    expect(find.byKey(const Key('join-device-id')), findsNothing); expect(tester.takeException(), isNull);
  });
}
