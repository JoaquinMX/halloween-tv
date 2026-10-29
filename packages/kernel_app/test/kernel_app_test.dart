import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kernel_app/kernel_app.dart';

final class _StubPlugin implements ChannelPlugin {
  @override
  final ChannelDescriptor descriptor;

  _StubPlugin(String id, [int version = 1])
    : descriptor = ChannelDescriptor(id: id, title: 'T $id', version: version);

  @override
  Widget build(ChannelContext context) => const SizedBox.shrink();
}

void main() {
  test('register + resolve round-trip', () {
    final reg = ChannelRegistry();
    final plugin = _StubPlugin('cctv');
    reg.register(plugin);
    expect(reg.resolve('cctv'), same(plugin));
    expect(reg.resolve('missing'), isNull);
    expect(reg.allIds, ['cctv']);
    expect(reg.contains('cctv'), isTrue);
    expect(reg.contains('missing'), isFalse);
    expect(reg.length, 1);
  });

  test('duplicate id rejected with StateError and original survives', () {
    final reg = ChannelRegistry();
    final first = _StubPlugin('cctv');
    reg.register(first);
    expect(() => reg.register(_StubPlugin('cctv', 2)), throwsStateError);
    expect(reg.allIds, ['cctv']);
    expect(reg.resolve('cctv'), same(first));
    expect(reg.length, 1);
  });

  test('blank channel id rejected with ArgumentError', () {
    final reg = ChannelRegistry();
    // Descriptor asserts block a literal '', so use a whitespace id.
    expect(() => reg.register(_StubPlugin('   ')), throwsArgumentError);
    expect(reg.allIds, isEmpty);
  });

  test('allIds keeps registration order and is unmodifiable', () {
    final reg = ChannelRegistry();
    reg.register(_StubPlugin('retro'));
    reg.register(_StubPlugin('cctv'));
    expect(reg.allIds, ['retro', 'cctv']);
    expect(() => reg.allIds.add('x'), throwsUnsupportedError);
  });

  test('buildChannelList returns descriptors sorted by id', () {
    final reg = ChannelRegistry();
    reg.register(_StubPlugin('retro', 2));
    reg.register(_StubPlugin('cctv', 3));
    final list = buildChannelList(reg);
    expect(list.map((d) => d.id).toList(), ['cctv', 'retro']);
    expect(list.map((d) => d.version).toList(), [3, 2]);
    expect(() => list.add(list.first), throwsUnsupportedError);
  });

  test('buildChannelList on empty registry is empty', () {
    expect(buildChannelList(ChannelRegistry()), isEmpty);
  });
}
