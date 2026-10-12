import { Chess, type Move } from "chess.js";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const FIGURINES: Record<string, string> = {
  "♔": "K", "♚": "K",
  "♕": "Q", "♛": "Q",
  "♖": "R", "♜": "R",
  "♗": "B", "♝": "B",
  "♘": "N", "♞": "N",
  "♙": "", "♟": "",
};

// SAN: Nf3, exd5, e8=Q+, O-O-O#
const SAN_RE = /^(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=?[QRBN])?|O-O(?:-O)?)[+#]?$/;
// Coordinate / long algebraic: e2e4, e2-e4, Ng1-f3, e7xd8=Q, e7-e8Q
const COORD_RE = /^[KQRBN]?([a-h][1-8])[-x:]?([a-h][1-8])(?:=?([QRBNqrbn]))?[+#]?$/;
const RESULT_RE = /^(?:1-0|0-1|1\/2-1\/2|½-½|\*)$/;

/** Normalize one raw token from a move list into SAN-ish or coordinate text. Returns null for non-moves. */
export function normalizeToken(raw: string): string | null {
  let t = raw.trim();
  if (!t) return null;
  for (const [fig, letter] of Object.entries(FIGURINES)) t = t.split(fig).join(letter);
  t = t.replace(/^\d+\.(\.\.)?/, ""); // "12.e4" / "12...e5"
  t = t.replace(/[!?]+$/, "");
  t = t.replace(/0-0-0/g, "O-O-O").replace(/0-0/g, "O-O");
  t = t.replace(/e\.?p\.?$/i, "");
  if (!t || RESULT_RE.test(t)) return null;
  if (SAN_RE.test(t) || COORD_RE.test(t)) return t;
  return null;
}

/** Split arbitrary move-log text into candidate move tokens, in order. */
export function tokenize(texts: string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    // Put a space after move numbers glued to moves ("1.e4"), then split on whitespace and commas.
    const spaced = text.replace(/(\d+\.(?:\.\.)?)(?=\S)/g, "$1 ");
    for (const piece of spaced.split(/[\s,;]+/)) {
      const n = normalizeToken(piece);
      if (n) out.push(n);
    }
  }
  return out;
}

/** Apply one normalized token. Tries SAN first, then coordinates. Returns the move or null if illegal. */
export function applyToken(chess: Chess, token: string): Move | null {
  try {
    return chess.move(token);
  } catch {
    /* not SAN in this position */
  }
  const m = COORD_RE.exec(token);
  if (!m) return null;
  try {
    return chess.move({ from: m[1]!, to: m[2]!, promotion: m[3]?.toLowerCase() ?? "q" });
  } catch {
    return null;
  }
}

export interface ReplayResult {
  /** UCI moves of the longest legal prefix. */
  uci: string[];
  san: string[];
  fen: string;
  /** Number of tokens that didn't fit (0 when the whole list was legal). */
  rejected: number;
}

/** Replay tokens from a start FEN, keeping the longest legal prefix. */
export function replay(tokens: string[], startFen: string = START_FEN): ReplayResult {
  const chess = new Chess(startFen);
  const uci: string[] = [];
  const san: string[] = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    const mv = applyToken(chess, tokens[i]!);
    if (!mv) break;
    uci.push(toUci(mv));
    san.push(mv.san);
  }
  return { uci, san, fen: chess.fen(), rejected: tokens.length - i };
}

export function toUci(m: Pick<Move, "from" | "to" | "promotion">): string {
  return `${m.from}${m.to}${m.promotion ?? ""}`;
}

/** Lichess sends castling as king-to-rook in some cases (e1h1). chess.js wants king-to-destination. */
export function applyUci(chess: Chess, uci: string): Move | null {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  const from = uci.slice(0, 2);
  let to = uci.slice(2, 4);
  const piece = chess.get(from as Parameters<Chess["get"]>[0]);
  if (piece?.type === "k") {
    const target = chess.get(to as Parameters<Chess["get"]>[0]);
    if (target?.type === "r" && target.color === piece.color) {
      to = `${to[0] === "h" ? "g" : "c"}${from[1]}`;
    }
  }
  try {
    return chess.move({ from, to, promotion: uci[4] });
  } catch {
    return null;
  }
}

/** Convert a UCI principal variation to SAN from a given FEN, stopping at the first illegal move. */
export function pvToSan(fen: string, pv: string[], max = 8): string[] {
  const chess = new Chess(fen);
  const out: string[] = [];
  for (const u of pv.slice(0, max)) {
    const mv = applyUci(chess, u);
    if (!mv) break;
    out.push(mv.san);
  }
  return out;
}

export function isValidFen(fen: string): boolean {
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}
