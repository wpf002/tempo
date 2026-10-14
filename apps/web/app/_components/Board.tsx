"use client";

import type { CSSProperties } from "react";
import { Chessboard, defaultAlphaNotationStyle, defaultArrowOptions, defaultNumericNotationStyle, type PieceDropHandlerArgs } from "react-chessboard";

export interface BoardArrow {
  uci: string;
  tone: "hint" | "best";
}

const noteStyle: CSSProperties = { fontSize: 12, fontWeight: 500, textTransform: "uppercase" };

/**
 * Board with an eval bar on its left edge.
 * `whiteShare` is White's winning share 0..1. Null draws an empty bar (no engine output to show).
 */
export function Board({
  id,
  fen,
  orientation,
  whiteShare = null,
  lastMove = null,
  highlight = null,
  arrows = [],
  onDrop,
}: {
  id: string;
  fen: string;
  orientation: "white" | "black";
  whiteShare?: number | null;
  lastMove?: string | null;
  highlight?: string | null;
  arrows?: BoardArrow[];
  onDrop?: (args: PieceDropHandlerArgs) => boolean;
}) {
  const squareStyles: Record<string, CSSProperties> = {};
  if (lastMove) {
    for (const sq of [lastMove.slice(0, 2), lastMove.slice(2, 4)]) squareStyles[sq] = { boxShadow: "inset 0 0 0 100px var(--sq-last)" };
  }
  if (highlight) {
    const prev = squareStyles[highlight]?.boxShadow;
    squareStyles[highlight] = { boxShadow: ["inset 0 0 0 4px var(--arrow-hint)", prev].filter(Boolean).join(", ") };
  }

  return (
    <div className="boardwrap">
      <div className={`evalbar${whiteShare === null ? " idle" : ""}${orientation === "black" ? " flipped" : ""}`} aria-hidden="true">
        <div className="fill" style={{ transform: `scaleY(${whiteShare ?? 0.5})` }} />
      </div>
      <div className="board">
        <Chessboard
          options={{
            id,
            position: fen,
            boardOrientation: orientation,
            allowDragging: !!onDrop,
            allowDrawingArrows: false,
            onPieceDrop: onDrop,
            animationDurationInMs: 200,
            squareStyles,
            arrows: arrows.map((a) => ({ startSquare: a.uci.slice(0, 2), endSquare: a.uci.slice(2, 4), color: `var(--arrow-${a.tone})` })),
            arrowOptions: { ...defaultArrowOptions, opacity: 0.85 },
            darkSquareStyle: { backgroundColor: "var(--sq-dark)" },
            lightSquareStyle: { backgroundColor: "var(--sq-light)" },
            darkSquareNotationStyle: { color: "var(--sq-note-on-dark)" },
            lightSquareNotationStyle: { color: "var(--sq-note-on-light)" },
            alphaNotationStyle: { ...defaultAlphaNotationStyle, ...noteStyle },
            numericNotationStyle: { ...defaultNumericNotationStyle, ...noteStyle },
          }}
        />
      </div>
    </div>
  );
}
