/// Adaptive focus traversal tests: 1/2/4 layouts share four stable nodes.
library;

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tv_app/src/wall/wall_focus.dart';

void main() {
  group('WallMove.targetFor', () {
    test('four-grid blocks edges instead of wrapping', () {
      expect(WallFocusController.targetFor(0, WallMove.left), -1);
      expect(WallFocusController.targetFor(0, WallMove.up), -1);
      expect(WallFocusController.targetFor(1, WallMove.right), -1);
      expect(WallFocusController.targetFor(2, WallMove.left), -1);
      expect(WallFocusController.targetFor(3, WallMove.right), -1);
      expect(WallFocusController.targetFor(3, WallMove.down), -1);
      expect(
        WallFocusController.targetFor(0, WallMove.right, columns: 2, tiles: 4),
        1,
      );
      expect(
        WallFocusController.targetFor(1, WallMove.down, columns: 2, tiles: 4),
        3,
      );
    });

    test('two-tile row moves horizontally only', () {
      expect(
        WallFocusController.targetFor(0, WallMove.right, columns: 2, tiles: 2),
        1,
      );
      expect(
        WallFocusController.targetFor(1, WallMove.left, columns: 2, tiles: 2),
        0,
      );
      expect(
        WallFocusController.targetFor(0, WallMove.left, columns: 2, tiles: 2),
        -1,
      );
      expect(
        WallFocusController.targetFor(1, WallMove.right, columns: 2, tiles: 2),
        -1,
      );
      expect(
        WallFocusController.targetFor(0, WallMove.down, columns: 2, tiles: 2),
        -1,
      );
      expect(
        WallFocusController.targetFor(1, WallMove.up, columns: 2, tiles: 2),
        -1,
      );
    });

    test('a single tile blocks every move', () {
      for (final WallMove move in WallMove.values) {
        expect(
          WallFocusController.targetFor(0, move, columns: 1, tiles: 1),
          -1,
          reason: '$move must be blocked for a single tile',
        );
      }
      expect(
        WallFocusController.targetFor(3, WallMove.left, columns: 1, tiles: 1),
        -1,
      );
    });
  });

  group('WallFocusController active layouts', () {
    test('defaults to the full 2x2 grid', () {
      final WallFocusController focus = WallFocusController();
      addTearDown(focus.dispose);
      expect(focus.activeTiles, 4);
      expect(focus.activeColumns, 2);
      expect(focus.nodes, hasLength(4));
    });

    test('two-tile layout traverses one row and ignores the rest', () {
      final WallFocusController focus = WallFocusController();
      addTearDown(focus.dispose);
      focus.setActiveLayout(tiles: 2, columns: 2);
      expect(focus.activeTiles, 2);

      focus.markFocused(0);
      expect(focus.moveFrom(0, WallMove.right), 1);
      expect(focus.moveFrom(1, WallMove.right), -1);
      expect(focus.moveFrom(1, WallMove.down), -1);
      expect(focus.moveFrom(0, WallMove.up), -1);
      // Moves act on the focus tree; bookkeeping only changes when the
      // widget reports back via markFocused.
      expect(focus.focusedIndex, 0);

      // Out-of-active-range slots are ignored, not focused.
      focus.focusTile(3);
      expect(focus.focusedIndex, 0);
    });

    test('single-tile layout blocks everything', () {
      final WallFocusController focus = WallFocusController();
      addTearDown(focus.dispose);
      focus.setActiveLayout(tiles: 1, columns: 1);

      focus.markFocused(0);
      for (final WallMove move in WallMove.values) {
        expect(focus.moveFrom(0, move), -1);
      }
      focus.focusTile(2);
      expect(focus.focusedIndex, 0);
    });

    test('shrinking clamps removed focus to a valid remaining tile', () {
      final WallFocusController focus = WallFocusController();
      addTearDown(focus.dispose);
      focus.markFocused(3);
      focus.setActiveLayout(tiles: 2, columns: 2);
      expect(focus.focusedIndex, 1);

      focus.markFocused(1);
      focus.setActiveLayout(tiles: 1, columns: 1);
      expect(focus.focusedIndex, 0);
    });

    test('growing keeps the current focus and restores traversal', () {
      final WallFocusController focus = WallFocusController();
      addTearDown(focus.dispose);
      focus.setActiveLayout(tiles: 1, columns: 1);
      focus.markFocused(0);
      focus.setActiveLayout(tiles: 4, columns: 2);
      expect(focus.focusedIndex, 0);
      expect(focus.moveFrom(0, WallMove.right), 1);
      expect(focus.moveFrom(1, WallMove.down), 3);
    });

    test('invalid layouts fall back to the full grid', () {
      final WallFocusController focus = WallFocusController();
      addTearDown(focus.dispose);
      focus.setActiveLayout(tiles: 3, columns: 0);
      expect(focus.activeTiles, 4);
      expect(focus.activeColumns, 2);
    });

    test('arrow keys follow the active layout', () {
      final WallFocusController focus = WallFocusController();
      addTearDown(focus.dispose);
      focus.setActiveLayout(tiles: 2, columns: 2);
      focus.markFocused(0);
      // Right consumes the key (a real tree would move); down is blocked
      // inside the two-tile row but still consumed; other keys bubble.
      expect(focus.handleArrow(LogicalKeyboardKey.arrowRight), isTrue);
      expect(focus.moveFrom(0, WallMove.right), 1);
      expect(focus.moveFrom(1, WallMove.down), -1);
      expect(focus.handleArrow(LogicalKeyboardKey.enter), isFalse);
    });
  });
}
