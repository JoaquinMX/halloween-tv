import 'package:test/test.dart';

import 'package:core_foundation/core_foundation.dart';

void main() {
  test('Result success unwraps value', () {
    const result = Success<int>(42);
    expect(result.isSuccess, isTrue);
    expect(result.valueOrNull, 42);
  });

  test('Result failure provides failure', () {
    const failure = ValidationFailure('oops');
    const Result<int> result = FailureResult<int>(failure);
    expect(result.isFailure, isTrue);
    expect(result.failureOrNull, failure);
  });
}
