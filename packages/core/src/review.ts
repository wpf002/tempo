import { Chess } from "chess.js";
import type { Analysis, Engine, Score } from "./engine.js";
import type { Coach, Explanation } from "./coach.js";
import { applyUci } from "./notation.js";
import { gradeMove, moveAccuracy, phaseOf, povChances, toWinPercent } from "./grade.js";
import type { GameRow, MistakeRow, MoveRow, Store } from "./store.js";

export interface ReviewOptions {
  movetimeMs: number;
  /** How many of the worst mistakes get a Claude explanation. */
  maxExplained?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface ReviewResult {
  gameId: string;
  accuracy: number;
  moves: MoveRow[];
  mistakes: MistakeRow[];
  summary: string;
  focus: string[];
}

/** Score for a position with no legal moves. */
function terminalScore(chess: Chess): Score {
  if (chess.isCheckmate()) return { cp: null, mate: chess.turn() === "w" ? -1 : 1 };
  return { cp: 0, mate: null };
}

function bestScore(a: Analysis, chess: Chess): Score {
  return a.lines[0]?.score ?? terminalScore(chess);
}

export async function reviewGame(
  deps: { engine: Engine; store: Store; coach: Coach | null },
  game: GameRow,
  opts: ReviewOptions,
): Promise<ReviewResult> {
  const { engine, store, coach } = deps;
  const chess = new Chess(game.startFen);
  const positions: { fen: string; analysis: Analysis; terminal: Score | null }[] = [];
  const total = game.moves.length + 1;

  await engine.newGame();

  // Analyse every position once. Eval after move i = best eval of position i+1.
  const sanList: string[] = [];
  const colors: ("w" | "b")[] = [];
  const fullmoves: number[] = [];
  for (let i = 0; i <= game.moves.length; i++) {
    const fen = chess.fen();
    const analysis = await engine.analyse(fen, { movetimeMs: opts.movetimeMs, multipv: 3 });
    positions.push({ fen, analysis, terminal: analysis.lines.length ? null : terminalScore(chess) });
    opts.onProgress?.(i + 1, total);
    if (i === game.moves.length) break;
    colors.push(chess.turn());
    fullmoves.push(chess.moveNumber());
    const mv = applyUci(chess, game.moves[i]!);
    if (!mv) throw new Error(`illegal move ${game.moves[i]} at ply ${i + 1}`);
    sanList.push(mv.san);
  }

  const scoreAt = (i: number): Score => positions[i]!.terminal ?? bestScore(positions[i]!.analysis, new Chess(positions[i]!.fen));

  const moves: MoveRow[] = [];
  const accs: number[] = [];
  for (let i = 0; i < game.moves.length; i++) {
    const before = scoreAt(i);
    const after = scoreAt(i + 1);
    const color = colors[i]!;
    const a = positions[i]!.analysis;
    const playedWasBest = a.bestMove === game.moves[i];
    const { grade, loss } = gradeMove(before, after, color, playedWasBest);
    moves.push({
      gameId: game.id,
      ply: i + 1,
      fenBefore: positions[i]!.fen,
      uci: game.moves[i]!,
      san: sanList[i]!,
      color,
      evalBefore: before,
      evalAfter: after,
      bestUci: a.bestMove,
      bestSan: a.lines[0]?.pvSan[0] ?? null,
      grade,
      loss,
      phase: phaseOf(positions[i]!.fen, fullmoves[i]!),
    });
    if (color === game.playerColor) {
      accs.push(moveAccuracy(toWinPercent(povChances(before, color)), toWinPercent(povChances(after, color))));
    }
  }
  const accuracy = accs.length ? accs.reduce((s, x) => s + x, 0) / accs.length : 100;

  // Player's errors, worst first. Top N get a Claude explanation.
  const errors = moves
    .filter((m) => m.color === game.playerColor && (m.grade === "inaccuracy" || m.grade === "mistake" || m.grade === "blunder") && m.bestUci)
    .sort((x, y) => y.loss - x.loss);
  const maxExplained = opts.maxExplained ?? 5;

  for (const [rank, m] of errors.entries()) {
    const shouldExplain = coach && rank < maxExplained;
    // Inaccuracies outside the explained set aren't worth a drill.
    if (!shouldExplain && m.grade === "inaccuracy") continue;
    let exp: Explanation = { motif: "other", explanation: "", takeaway: "" };
    if (shouldExplain) {
      try {
        exp = await coach.explainMove({
          fenBefore: m.fenBefore,
          playedSan: m.san,
          playedScore: m.evalAfter,
          grade: m.grade,
          bestLines: positions[m.ply - 1]!.analysis.lines,
          playerColor: m.color,
          phase: m.phase,
          moveNumber: fullmoves[m.ply - 1]!,
        });
      } catch {
        /* coach is best-effort; engine grading still stands */
      }
    }
    store.addMistake({
      gameId: game.id,
      ply: m.ply,
      fen: m.fenBefore,
      playedSan: m.san,
      bestUci: m.bestUci!,
      bestSan: m.bestSan ?? m.bestUci!,
      grade: m.grade,
      motif: exp.motif,
      explanation: exp.explanation,
      takeaway: exp.takeaway,
      phase: m.phase,
    });
  }

  const mistakes = store.getMistakes(game.id);
  let summary = "";
  let focus: string[] = [];
  if (coach) {
    try {
      const s = await coach.summarizeGame({
        playerColor: game.playerColor,
        result: game.result ?? "unknown",
        accuracy,
        mistakes: mistakes.map((x) => ({
          moveNumber: Math.ceil(x.ply / 2),
          san: x.playedSan,
          grade: x.grade,
          motif: x.motif,
          phase: x.phase,
          bestSan: x.bestSan,
        })),
        history: store.motifCounts(),
      });
      summary = s.summary;
      focus = s.focus;
    } catch {
      /* best-effort */
    }
  }

  store.saveReview(game.id, moves, accuracy, summary, focus);
  return { gameId: game.id, accuracy, moves, mistakes, summary, focus };
}

/** Is a drill answer correct? Correct if it's the engine's move or within 0.05 winning chances of it. */
export async function checkDrillAnswer(engine: Engine, fen: string, answerUci: string, bestUci: string, movetimeMs = 800): Promise<{ correct: boolean; bestSan: string | null }> {
  const chess = new Chess(fen);
  const color = chess.turn();
  const probe = new Chess(fen);
  if (!applyUci(probe, answerUci)) return { correct: false, bestSan: null };
  const a = await engine.analyse(fen, { movetimeMs, multipv: 1 });
  const bestSan = a.lines[0]?.pvSan[0] ?? null;
  if (answerUci === bestUci || answerUci === a.bestMove) return { correct: true, bestSan };
  const scored = await engine.analyse(fen, { movetimeMs, multipv: 1, searchMoves: [answerUci] });
  const best = a.lines[0]?.score;
  const got = scored.lines[0]?.score;
  if (!best || !got) return { correct: false, bestSan };
  return { correct: povChances(best, color) - povChances(got, color) <= 0.05, bestSan };
}
