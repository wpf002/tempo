"use client";

import { useEffect, useMemo, useState } from "react";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import { api, fmt, whiteShare, type GameRow, type MistakeRow, type MoveRow } from "./api";
import { ExplainCard } from "./Live";

interface Detail {
  game: GameRow;
  moves: MoveRow[];
  mistakes: MistakeRow[];
}

const boardStyles = {
  darkSquareStyle: { backgroundColor: "var(--sq-dark)" },
  lightSquareStyle: { backgroundColor: "var(--sq-light)" },
};

function EvalGraph({ moves, ply, onPick }: { moves: MoveRow[]; ply: number; onPick: (p: number) => void }) {
  const W = 400;
  const H = 80;
  const pts = [moves[0]?.evalBefore, ...moves.map((m) => m.evalAfter)].filter(Boolean).map((s) => whiteShare(s!));
  if (pts.length < 2) return null;
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => H - v * H;
  const path = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", cursor: "pointer" }}
      onClick={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        onPick(Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1)));
      }}
      role="img" aria-label="Evaluation over the game">
      <rect width={W} height={H} fill="#2b2925" />
      <path d={`${path} L${W},${H} L0,${H} Z`} fill="#ece6da" />
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke="#9b9486" strokeDasharray="3 3" strokeWidth="0.6" />
      {moves.map((m) =>
        ["mistake", "blunder"].includes(m.grade) ? (
          <circle key={m.ply} cx={x(m.ply)} cy={y(pts[m.ply]!)} r="3" fill={m.grade === "blunder" ? "#e0503c" : "#e08a3c"} />
        ) : null,
      )}
      <line x1={x(ply)} x2={x(ply)} y1="0" y2={H} stroke="#d9a441" strokeWidth="1.5" />
    </svg>
  );
}

export function Review({ refreshKey }: { refreshKey: number }) {
  const [games, setGames] = useState<GameRow[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [ply, setPly] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<GameRow[]>("/api/games")
      .then((g) => {
        setGames(g);
        setSel((cur) => cur ?? g[0]?.id ?? null);
      })
      .catch(() => setErr("Couldn't reach the daemon."));
  }, [refreshKey]);

  useEffect(() => {
    if (!sel) return;
    api<Detail>(`/api/games/${sel}`)
      .then((d) => {
        setDetail(d);
        setPly(0);
      })
      .catch(() => setErr("Couldn't load that game."));
  }, [sel, refreshKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!detail) return;
      if (e.key === "ArrowRight") setPly((p) => Math.min(detail.game.moves.length, p + 1));
      if (e.key === "ArrowLeft") setPly((p) => Math.max(0, p - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);

  const view = useMemo(() => {
    if (!detail) return null;
    const c = new Chess(detail.game.startFen);
    for (const u of detail.game.moves.slice(0, ply)) {
      try {
        c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      } catch {
        break;
      }
    }
    const shownFen = c.fen();
    const next = detail.moves[ply];
    const arrows = next?.bestUci && ["inaccuracy", "mistake", "blunder"].includes(next.grade)
      ? [{ startSquare: next.bestUci.slice(0, 2), endSquare: next.bestUci.slice(2, 4), color: "rgba(111,191,115,0.85)" }]
      : [];
    return { fen: shownFen, next, arrows };
  }, [detail, ply]);

  const reviewNow = async () => {
    if (!sel) return;
    await api(`/api/games/${sel}/review`, { method: "POST", body: "{}" }).catch(() => setErr("Couldn't queue review."));
  };

  if (err) return <div className="card muted">{err}</div>;
  if (!games.length) return <div className="card muted">No games yet. Play one and it shows up here.</div>;

  return (
    <div className="split">
      <div className="gamelist">
        {games.map((g) => (
          <button key={g.id} aria-current={g.id === sel} onClick={() => setSel(g.id)}>
            <div>vs {g.opponent}</div>
            <div className="meta mono">
              {new Date(g.startedAt).toLocaleDateString()} · {g.result ?? "…"} · {g.accuracy != null ? `${g.accuracy.toFixed(0)}%` : "not reviewed"}
            </div>
          </button>
        ))}
      </div>

      {detail && view && (
        <div>
          {detail.game.reviewedAt ? (
            <div className="card">
              <h3>Summary · accuracy {detail.game.accuracy?.toFixed(0)}%</h3>
              {detail.game.summary && <p style={{ marginTop: 0 }}>{detail.game.summary}</p>}
              {detail.game.focus.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {detail.game.focus.map((f) => <li key={f}>{f}</li>)}
                </ul>
              )}
            </div>
          ) : (
            <div className="card row">
              <span className="muted grow">Not reviewed yet.</span>
              <button className="btn primary" onClick={reviewNow}>Review this game</button>
            </div>
          )}

          <div className="reviewgrid">
            <div>
              <div className="board">
                <Chessboard options={{
                  id: "review",
                  position: view.fen,
                  boardOrientation: detail.game.playerColor === "w" ? "white" : "black",
                  allowDragging: false,
                  arrows: view.arrows,
                  ...boardStyles,
                }} />
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn" onClick={() => setPly(0)}>⏮</button>
                <button className="btn" onClick={() => setPly((p) => Math.max(0, p - 1))}>◀</button>
                <button className="btn" onClick={() => setPly((p) => Math.min(detail.game.moves.length, p + 1))}>▶</button>
                <span className="muted mono">ply {ply}/{detail.game.moves.length}</span>
              </div>
              {detail.moves.length > 0 && <div className="card" style={{ marginTop: 10, padding: 8 }}><EvalGraph moves={detail.moves} ply={ply} onPick={setPly} /></div>}
            </div>

            <div>
              {view.next && (
                <div className="card">
                  <h3>Next move</h3>
                  <div className="row">
                    <span className="mono">{view.next.san}</span>
                    <span className={`grade g-${view.next.grade}`}>{view.next.grade}</span>
                    <span className="muted mono">{fmt(view.next.evalBefore)} → {fmt(view.next.evalAfter)}</span>
                    {view.next.bestSan && view.next.bestSan !== view.next.san && <span className="muted">best {view.next.bestSan}</span>}
                  </div>
                </div>
              )}
              <div className="card">
                <h3>Moves</h3>
                <div className="moves">
                  {(detail.moves.length ? detail.moves : []).map((m) => (
                    <span key={m.ply}>
                      {m.color === "w" && <span className="num">{Math.ceil(m.ply / 2)}.</span>}
                      <button className={`mv-${m.grade}`} aria-current={ply === m.ply - 1} onClick={() => setPly(m.ply - 1)}>{m.san}</button>
                    </span>
                  ))}
                  {!detail.moves.length && <span className="muted">Moves appear after review.</span>}
                </div>
              </div>
              {detail.mistakes.map((m) => (
                <div key={m.id} className={`mistake ${m.grade}`} onClick={() => setPly(m.ply - 1)} style={{ cursor: "pointer" }}>
                  {m.explanation ? (
                    <ExplainCard e={m} about={`move ${Math.ceil(m.ply / 2)} ${m.playedSan} (${m.grade}), best ${m.bestSan}`} />
                  ) : (
                    <div className="card">
                      <h3>Move {Math.ceil(m.ply / 2)} · {m.grade}</h3>
                      {m.playedSan}. Best was {m.bestSan}.
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
