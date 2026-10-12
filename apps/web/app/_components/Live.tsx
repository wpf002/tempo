"use client";

import type { ClientMessage, Explanation, LiveState } from "./api";
import { whiteShare } from "./api";

export function ExplainCard({ e, about }: { e: Explanation; about?: string }) {
  return (
    <div className="card explain">
      <h3>Coach{about ? ` · ${about}` : ""}</h3>
      <span className="motif">{e.motif}</span>
      <p>{e.explanation}</p>
      {e.takeaway && <p className="takeaway">{e.takeaway}</p>}
    </div>
  );
}

export function Live({
  state,
  send,
  explanation,
  explaining,
  onExplain,
}: {
  state: LiveState | null;
  send: (m: ClientMessage) => void;
  explanation: { e: Explanation; about: string } | null;
  explaining: boolean;
  onExplain: () => void;
}) {
  if (!state) return <div className="card muted">Connecting to the Tempo daemon…</div>;
  const g = state.game;
  const tier = state.hints.length;

  return (
    <div className="livegrid">
      <div className="chips">
        {state.sources.map((s) => (
          <span key={s.source} className={`chip ${s.state}`} title={s.detail}>
            <b>{s.source === "chessapp" ? "Chess.app" : "Lichess"}</b>
            {s.detail || s.state}
          </span>
        ))}
      </div>

      {!g ? (
        <div className="card">
          <h3>Waiting</h3>
          <p className="muted" style={{ margin: 0 }}>
            Start a game against the computer in Chess.app, or against Lichess AI. Tempo picks it up automatically.
          </p>
        </div>
      ) : (
        <>
          <div className="card">
            <h3>
              {g.source === "chessapp" ? "Chess.app" : "Lichess"} · vs {g.opponent}
            </h3>
            <div className="row">
              <span className="muted">You play</span>
              {g.source === "chessapp" ? (
                <span className="seg">
                  {(["w", "b"] as const).map((c) => (
                    <button key={c} aria-pressed={g.playerColor === c} onClick={() => send({ type: "setColor", color: c })}>
                      {c === "w" ? "White" : "Black"}
                    </button>
                  ))}
                </span>
              ) : (
                <b>{g.playerColor === "w" ? "White" : "Black"}</b>
              )}
              <span className="grow" />
              {g.finished ? (
                <span className="mono">{g.result}</span>
              ) : (
                <span className={g.yourTurn ? "" : "muted"}>{g.yourTurn ? "Your move" : "Their move"}</span>
              )}
            </div>
            <div className="moves" style={{ marginTop: 10 }}>
              {g.san.slice(-12).map((m, i, arr) => {
                const ply = g.san.length - arr.length + i;
                return (
                  <span key={ply}>
                    {ply % 2 === 0 && <span className="num">{ply / 2 + 1}.</span>} {m}
                  </span>
                );
              })}
              {!g.san.length && <span className="muted">No moves yet.</span>}
            </div>
            {g.source === "chessapp" && (
              <div className="row" style={{ marginTop: 12 }}>
                <label className="row muted" style={{ gap: 6 }}>
                  <input type="checkbox" checked={state.chessappHints} onChange={(e) => send({ type: "chessappHints", on: e.target.checked })} />
                  Live hints (computer games only)
                </label>
                <span className="grow" />
                {!g.finished && (
                  <button className="btn" onClick={() => send({ type: "endChessAppGame" })}>
                    End game &amp; review
                  </button>
                )}
              </div>
            )}
          </div>

          {state.live.allowed ? (
            <>
              <div className="card">
                <h3>Evaluation</h3>
                <div className="evalbar" aria-label={`Evaluation ${state.eval?.text ?? "pending"}`}>
                  <div className="white" style={{ width: `${(state.eval ? whiteShare(state.eval.score) : 0.5) * 100}%` }} />
                  <div className="label">{state.eval?.text ?? (state.thinking ? "…" : "–")}</div>
                </div>
                {state.lastGrade && (
                  <div className="row" style={{ marginTop: 10 }}>
                    <span className="mono">{state.lastGrade.san}</span>
                    <span className={`grade g-${state.lastGrade.grade}`}>{state.lastGrade.grade}</span>
                    <span className="muted mono">
                      {state.lastGrade.before} → {state.lastGrade.after}
                    </span>
                    {["inaccuracy", "mistake", "blunder"].includes(state.lastGrade.grade) && state.lastGrade.bestSan && (
                      <span className="muted">Best was {state.lastGrade.bestSan}</span>
                    )}
                  </div>
                )}
              </div>

              <div className="card">
                <h3>Hints</h3>
                <div className="row">
                  <button className="btn primary" disabled={!g.yourTurn || tier >= 3 || state.thinking} onClick={() => send({ type: "hint" })}>
                    {tier === 0 ? "Hint" : tier < 3 ? "Bigger hint" : "Full hint shown"}
                  </button>
                  <button className="btn" disabled={explaining || (tier < 3 && !state.lastGrade)} onClick={onExplain}>
                    {explaining ? "Thinking…" : tier >= 3 ? "Why is that best?" : "Explain my last move"}
                  </button>
                  <span className="muted mono">{tier}/3</span>
                </div>
                {state.hints.length > 0 && (
                  <ol className="hints">
                    {state.hints.map((h) => (
                      <li key={h.tier}>
                        <small>{["Nudge", "Piece", "Move"][h.tier - 1]}</small>
                        {h.text}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </>
          ) : (
            <div className="card">
              <h3>Live coaching off</h3>
              <p className="muted" style={{ margin: 0 }}>{state.live.reason}</p>
            </div>
          )}

          {explanation && <ExplainCard e={explanation.e} about={explanation.about} />}
        </>
      )}

      {state.review && (
        <div className="card">
          <h3>Reviewing game</h3>
          <span className="muted mono">
            {state.review.done}/{state.review.total} positions
          </span>
          <div className="progress">
            <div style={{ width: `${(100 * state.review.done) / state.review.total}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
