import 'package:flutter_test/flutter_test.dart';
import 'package:kernel_app/kernel_app.dart';

void main() {
  testWidgets('KernelApp renders loading indicator', (tester) async {
    await tester.pumpWidget(const KernelApp());
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });
}
