"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { api, fmt, whiteShare, type GameRow, type Grade, type LiveState, type MistakeRow, type MoveRow } from "./api";
import { Board } from "./Board";
import { EvalGraph } from "./charts";
import { ExplainBody, GradeTag, Icon, glyph, isError, outcome } from "./ui";

interface Detail {
  game: GameRow;
  moves: MoveRow[];
  mistakes: MistakeRow[];
}

const ERRORS: Grade[] = ["inaccuracy", "mistake", "blunder"];

export function Review({ refreshKey, reviewing }: { refreshKey: number; reviewing: LiveState["review"] }) {
  const [games, setGames] = useState<GameRow[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [ply, setPly] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loaded = useRef<string | null>(null);

  useEffect(() => {
    api<GameRow[]>("/api/games")
      .then((g) => {
        setErr(null);
        setGames(g);
        setSel((cur) => cur ?? g[0]?.id ?? null);
      })
      .catch(() => setErr("Daemon Offline"));
  }, [refreshKey, attempt]);

  useEffect(() => {
    if (!sel) return;
    let stale = false;
    api<Detail>(`/api/games/${sel}`)
      .then((d) => {
        if (stale) return;
        setErr(null);
        // Keep your place when the same game reloads after a review finishes.
        if (loaded.current !== d.game.id) setPly(0);
        loaded.current = d.game.id;
        setDetail(d);
      })
      .catch(() => !stale && setErr("Can't Load Game"));
    return () => {
      stale = true;
    };
  }, [sel, refreshKey, attempt]);

  const total = detail?.game.moves.length ?? 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setPly((p) => Math.min(total, p + 1));
      if (e.key === "ArrowLeft") setPly((p) => Math.max(0, p - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [total]);

  // Positions and SAN come from replaying the game, so an unreviewed game can still be stepped through.
  const line = useMemo(() => {
    if (!detail) return null;
    const c = new Chess(detail.game.startFen);
    const fens = [c.fen()];
    const sans: string[] = [];
    for (const u of detail.game.moves) {
      try {
        sans.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
      } catch {
        break;
      }
      fens.push(c.fen());
    }
    return { fens, sans };
  }, [detail]);

  if (err) {
    return (
      <div className="card empty">
        <h2 className="title">{err}</h2>
        <code>pnpm dev</code>
        <button className="btn" onClick={() => setAttempt((a) => a + 1)}>
          Try Again
        </button>
      </div>
    );
  }
  if (!games) {
    return (
      <div className="review" aria-busy="true" aria-label="Loading games">
        <div className="skeleton" style={{ height: 240 }} />
        <div className="skeleton" style={{ aspectRatio: "1", maxWidth: 640 }} />
        <div className="skeleton" style={{ height: 240 }} />
      </div>
    );
  }
  if (!games.length) {
    return (
      <div className="card empty">
        <h2 className="title">No Games Yet</h2>
      </div>
    );
  }

  const game = detail?.game;
  const next = detail?.moves[ply];
  const prev = ply > 0 ? detail?.moves[ply - 1] : undefined;
  const evalHere = next?.evalBefore ?? prev?.evalAfter ?? null;
  const mine = detail?.moves.filter((m) => m.color === game?.playerColor) ?? [];
  const busy = reviewing && reviewing.gameId === sel ? reviewing : null;

  const reviewNow = () => {
    if (sel) api(`/api/games/${sel}/review`, { method: "POST", body: "{}" }).catch(() => setErr("Can't Start Review"));
  };

  return (
    <div className="review">
      <nav className="gamelist" aria-label="Games">
        {games.map((g) => (
          <button key={g.id} className="game" aria-current={g.id === sel} onClick={() => setSel(g.id)}>
            <span className="who">vs {g.opponent}</span>
            <span className="meta">
              <span>{new Date(g.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
              <span>{outcome(g.result, g.playerColor)}</span>
              <span>{g.accuracy != null ? `${g.accuracy.toFixed(0)}%` : "Not reviewed"}</span>
            </span>
          </button>
        ))}
      </nav>

      {game && line && (
        <>
          <div className="stage">
            <Board
              id="review"
              fen={line.fens[Math.min(ply, line.fens.length - 1)]!}
              orientation={game.playerColor === "w" ? "white" : "black"}
              whiteShare={evalHere ? whiteShare(evalHere) : null}
              lastMove={ply > 0 ? game.moves[ply - 1] : null}
              arrows={next?.bestUci && isError(next.grade) ? [{ uci: next.bestUci, tone: "best" }] : []}
            />
            <div className="controls">
              <button className="btn icon" aria-label="First position" disabled={ply === 0} onClick={() => setPly(0)}>
                <Icon name="first" />
              </button>
              <button className="btn icon" aria-label="Previous move" disabled={ply === 0} onClick={() => setPly((p) => Math.max(0, p - 1))}>
                <Icon name="prev" />
              </button>
              <button className="btn icon" aria-label="Next move" disabled={ply >= total} onClick={() => setPly((p) => Math.min(total, p + 1))}>
                <Icon name="next" />
              </button>
              <button className="btn icon" aria-label="Last position" disabled={ply >= total} onClick={() => setPly(total)}>
                <Icon name="last" />
              </button>
              <span className="where">
                {ply} of {total} · arrow keys step
              </span>
            </div>
            {detail.moves.length > 1 && (
              <div className="card graph">
                <EvalGraph moves={detail.moves} ply={ply} onPick={setPly} />
              </div>
            )}
          </div>

          <div className="stack">
            {game.reviewedAt ? (
              <div className="card">
                <div className="card-head">
                  <h3 className="card-title">Accuracy</h3>
                  <span className="muted small">
                    {outcome(game.result, game.playerColor)} as {game.playerColor === "w" ? "White" : "Black"}
                  </span>
                </div>
                <div className="big">{game.accuracy?.toFixed(0)}%</div>
                <div className="tally">
                  {ERRORS.map((g) => (
                    <GradeTag key={g} grade={g} count={mine.filter((m) => m.grade === g).length} />
                  ))}
                </div>
                {game.summary && <p className="prose">{game.summary}</p>}
                {game.focus.length > 0 && (
                  <div className="rule">
                    <span className="label">Focus</span>
                    <ul className="focus">
                      {game.focus.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="card">
                <h3 className="card-title">{busy ? "Reviewing" : "Not Reviewed"}</h3>
                {busy ? (
                  <>
                    <p className="small muted nums">
                      {busy.done} of {busy.total} positions analysed
                    </p>
                    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={busy.total} aria-valuenow={busy.done}>
                      <div style={{ transform: `scaleX(${busy.done / busy.total})` }} />
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <button className="btn primary" onClick={reviewNow}>
                        Review Game
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {next && (
              <div className="card">
                <h3 className="card-title">
                  Move {Math.ceil(next.ply / 2)} · {next.color === game.playerColor ? "Yours" : "Theirs"}
                </h3>
                <div className="lastmove">
                  <span className="san">{next.san}</span>
                  <GradeTag grade={next.grade} />
                  <span className="muted small nums">
                    {fmt(next.evalBefore)} → {fmt(next.evalAfter)}
                  </span>
                </div>
                {isError(next.grade) && next.bestSan && (
                  <p className="small">
                    <span className="muted">Best was</span> <b>{next.bestSan}</b>
                  </p>
                )}
              </div>
            )}

            <div className="card">
              <h3 className="card-title">Moves</h3>
              <div className="moves">
                {line.sans.map((san, i) => {
                  const m = detail.moves[i];
                  return (
                    <span key={i} style={{ display: "contents" }}>
                      {i % 2 === 0 && <span className="num">{i / 2 + 1}.</span>}
                      <button className="move" aria-current={ply === i} onClick={() => setPly(i)}>
                        {san}
                        {m && isError(m.grade) && (
                          <>
                            <span className="glyph">{glyph(m.grade)}</span>
                            <span className={`mark ${m.grade}`} />
                            <span className="sr-only">{m.grade}</span>
                          </>
                        )}
                      </button>
                    </span>
                  );
                })}
              </div>
            </div>

            {detail.mistakes.map((m) => (
              <article key={m.id} className="mcard" aria-current={ply === m.ply - 1}>
                <button className="mcard-head" onClick={() => setPly(m.ply - 1)}>
                  <span className="lastmove">
                    <span className="muted small nums">Move {Math.ceil(m.ply / 2)}</span>
                    <b>{m.playedSan}</b>
                    <GradeTag grade={m.grade} />
                  </span>
                  <span className="small">
                    <span className="muted">Best</span> <b>{m.bestSan}</b>
                  </span>
                </button>
                {m.explanation && <ExplainBody e={m} />}
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
