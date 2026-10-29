/// Minimal D-pad focus traversal for the 2x2 wall (no touch assumption).
library;

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// Direction of a D-pad move.
enum WallMove { left, right, up, down }

/// Owns one [FocusNode] per wall slot and moves between them on arrows.
///
/// Movement is grid-shaped: left/right stay inside a row, up/down move two
/// slots, and moves that would leave the grid are ignored (TV remotes should
/// not wrap and lose the user).
final class WallFocusController {
  /// Creates a controller for a [columns] x [tiles ~/ columns] grid.
  WallFocusController({this.columns = 2, this.tiles = 4})
      : assert(columns > 0),
        assert(tiles > 0),
        _nodes = List<FocusNode>.generate(
          tiles,
          (int index) => FocusNode(debugLabel: 'wall-tile-$index'),
          growable: false,
        );

  /// Grid width.
  final int columns;

  /// Number of tiles.
  final int tiles;

  final List<FocusNode> _nodes;
  int _focusedIndex = -1;

  /// Focus node for wall slot [index].
  FocusNode nodeAt(int index) => _nodes[index];

  /// All focus nodes, in slot order.
  List<FocusNode> get nodes => List<FocusNode>.unmodifiable(_nodes);

  /// Slot currently holding focus, or `-1` when none.
  int get focusedIndex => _focusedIndex;

  /// Records that slot [index] gained focus.
  void markFocused(int index) {
    _focusedIndex = index;
  }

  /// Focuses slot [index]; ignores out-of-range values.
  void focusTile(int index) {
    if (index < 0 || index >= tiles) {
      return;
    }
    _nodes[index].requestFocus();
  }

  /// Index a [move] from [from] would land on, or `-1` when blocked.
  static int targetFor(int from, WallMove move, {int columns = 2, int tiles = 4}) {
    if (from < 0 || from >= tiles) {
      return -1;
    }
    final int column = from % columns;
    switch (move) {
      case WallMove.left:
        return column == 0 ? -1 : from - 1;
      case WallMove.right:
        return column == columns - 1 ? -1 : from + 1;
      case WallMove.up:
        return from - columns >= 0 ? from - columns : -1;
      case WallMove.down:
        return from + columns < tiles ? from + columns : -1;
    }
  }

  /// Applies [move] from the current slot; returns the new index or `-1`.
  int moveFrom(int from, WallMove move) {
    final int target = targetFor(from, move, columns: columns, tiles: tiles);
    if (target < 0) {
      return -1;
    }
    focusTile(target);
    return target;
  }

  /// Translates an arrow key press into a wall move.
  ///
  /// Returns true when the event was consumed (an arrow key), false
  /// otherwise so other keys can keep bubbling.
  bool handleArrow(LogicalKeyboardKey key) {
    final WallMove? move = switch (key) {
      LogicalKeyboardKey.arrowLeft => WallMove.left,
      LogicalKeyboardKey.arrowRight => WallMove.right,
      LogicalKeyboardKey.arrowUp => WallMove.up,
      LogicalKeyboardKey.arrowDown => WallMove.down,
      _ => null,
    };
    if (move == null) {
      return false;
    }
    final int from = _focusedIndex;
    if (from < 0) {
      focusTile(0);
      return true;
    }
    moveFrom(from, move);
    return true;
  }

  /// Releases every focus node.
  void dispose() {
    for (final FocusNode node in _nodes) {
      node.dispose();
    }
  }
}
