"use client";

import { useEffect, useRef, useState } from "react";
import { DAEMON, START_FEN, whiteShare, type ClientMessage, type Explanation, type LiveState } from "./api";
import { Board } from "./Board";
import { ExplainBody, GradeTag, StatusDot, isError, sourceName } from "./ui";

const TIERS = ["Nudge", "Piece", "Move"];

function Offline() {
  return (
    <div className="card empty">
      <h2 className="title">Can't reach the Tempo daemon</h2>
      <p className="muted prose">
        The panel talks to a local process at <code>{DAEMON.replace(/^https?:\/\//, "")}</code>. Start it with <code>pnpm dev</code> from the repo root. This page reconnects on its own.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="live" aria-busy="true" aria-label="Connecting to the Tempo daemon">
      <div className="stage">
        <div className="boardwrap">
          <div className="evalbar idle" />
          <div className="board skeleton" />
        </div>
      </div>
      <div className="stack">
        <div className="skeleton" style={{ height: 160 }} />
        <div className="skeleton" style={{ height: 96 }} />
      </div>
    </div>
  );
}

/** Show the skeleton for a moment before declaring the daemon unreachable, so a normal page load doesn't flash an error. */
function Connecting({ connected }: { connected: boolean }) {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 1500);
    return () => clearTimeout(t);
  }, []);
  return connected || !waited ? <Skeleton /> : <Offline />;
}

function Sources({ sources }: { sources: LiveState["sources"] }) {
  return (
    <ul className="sources">
      {sources.map((s) => (
        <li key={s.source}>
          <StatusDot state={s.state} />
          <span>
            <span className="name">{sourceName(s.source)}</span> <span className="muted small">{s.state}</span>
          </span>
          {s.detail && <span className="detail">{s.detail}</span>}
        </li>
      ))}
      {!sources.length && <li className="muted small">No sources enabled. Set TEMPO_SOURCES in .env.</li>}
    </ul>
  );
}

function ReviewProgress({ review }: { review: NonNullable<LiveState["review"]> }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">Reviewing your last game</h3>
        <span className="muted small nums">
          {review.done} of {review.total} positions
        </span>
      </div>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={review.total} aria-valuenow={review.done}>
        <div style={{ transform: `scaleX(${review.done / review.total})` }} />
      </div>
    </div>
  );
}

function MoveList({ san }: { san: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [san.length]);
  if (!san.length) return <p className="muted small">No moves yet.</p>;
  return (
    <div className="moves" ref={ref}>
      {san.map((m, i) => (
        <span key={i} style={{ display: "contents" }}>
          {i % 2 === 0 && <span className="num">{i / 2 + 1}.</span>}
          <span className="move" aria-current={i === san.length - 1}>
            {m}
          </span>
        </span>
      ))}
    </div>
  );
}

export function Live({
  state,
  connected,
  send,
  explanation,
  explaining,
  onExplain,
}: {
  state: LiveState | null;
  connected: boolean;
  send: (m: ClientMessage) => void;
  explanation: { e: Explanation; about: string } | null;
  explaining: boolean;
  onExplain: () => void;
}) {
  if (!state) return <Connecting connected={connected} />;
  const g = state.game;
  const tier = state.hints.length;

  if (!g) {
    return (
      <div className="live">
        <div className="stage">
          <Board id="live" fen={START_FEN} orientation="white" />
        </div>
        <div className="stack">
          <div className="card">
            <h2 className="title">Waiting for a game</h2>
            <p className="muted prose">Start a game against the computer in Chess.app or against Lichess AI. Tempo picks it up on the first move.</p>
            <Sources sources={state.sources} />
          </div>
          {state.review && <ReviewProgress review={state.review} />}
        </div>
      </div>
    );
  }

  const you = g.playerColor;
  const them = you === "w" ? "b" : "w";
  const hintSquare = tier === 2 ? state.hints[1]?.square : null;
  const hintMove = tier >= 3 ? state.hints[2]?.uci : null;
  const lg = state.lastGrade;

  return (
    <div className="live">
      <div className="stage">
        <div className="player">
          <span className={`swatch ${them}`} />
          <span className="name">{g.opponent}</span>
          {state.eval && (
            <span className="aside">
              Eval <span className="evalnum">{state.eval.text}</span>
            </span>
          )}
        </div>
        <Board
          id="live"
          fen={g.fen}
          orientation={you === "w" ? "white" : "black"}
          whiteShare={state.eval ? whiteShare(state.eval.score) : null}
          lastMove={g.lastMove}
          highlight={hintSquare}
          arrows={hintMove ? [{ uci: hintMove, tone: "hint" }] : []}
        />
        <div className="player">
          <span className={`swatch ${you}`} />
          <span className="name">You</span>
          <span className="aside">
            {g.finished ? (
              <>Game over · {g.result}</>
            ) : g.yourTurn ? (
              <>
                <span className="dot ok" />
                Your move
              </>
            ) : (
              "Their move"
            )}
          </span>
        </div>
      </div>

      <div className="stack">
        {state.live.allowed ? (
          <div className="card">
            <div className="card-head">
              <h3 className="card-title">Coach</h3>
              <span className="pips" role="img" aria-label={`Hint level ${tier} of 3`}>
                {TIERS.map((t, i) => (
                  <span key={t} className={i < tier ? "on" : ""} />
                ))}
              </span>
            </div>
            {tier > 0 ? (
              <ol className="hints">
                {state.hints.map((h) => (
                  <li key={h.tier} className="hint">
                    <span className="label">{TIERS[h.tier - 1]}</span>
                    {h.text}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted prose">
                {state.thinking ? "Analysing the position." : g.yourTurn ? "Stuck? Each hint gives away a little more: the idea, then the piece, then the move." : "Hints unlock on your move."}
              </p>
            )}
            <div className="row tight">
              <button className="btn primary" disabled={!g.yourTurn || tier >= 3 || state.thinking} onClick={() => send({ type: "hint" })}>
                {tier === 0 ? "Get a hint" : tier < 3 ? "Bigger hint" : "Full hint shown"}
              </button>
              <button className="btn" disabled={explaining || (tier < 3 && !lg)} aria-busy={explaining} onClick={onExplain}>
                {tier >= 3 ? "Why is that best?" : "Explain my last move"}
              </button>
            </div>
            {explanation && (
              <div className="rule">
                <span className="label">On {explanation.about}</span>
                <ExplainBody e={explanation.e} />
              </div>
            )}
          </div>
        ) : (
          <div className="card">
            <h3 className="card-title">Live coaching is off</h3>
            <p className="prose">{state.live.reason}</p>
          </div>
        )}

        {lg && (
          <div className="card">
            <h3 className="card-title">Your last move</h3>
            <div className="lastmove">
              <span className="san">{lg.san}</span>
              <GradeTag grade={lg.grade} />
              <span className="muted small nums">
                {lg.before} → {lg.after}
              </span>
            </div>
            {isError(lg.grade) && lg.bestSan && (
              <p className="small">
                <span className="muted">Best was</span> <b>{lg.bestSan}</b>
              </p>
            )}
          </div>
        )}

        <div className="card">
          <h3 className="card-title">Moves</h3>
          <MoveList san={g.san} />
        </div>

        {g.source === "chessapp" && (
          <div className="card">
            <h3 className="card-title">Chess.app game</h3>
            <div className="row">
              <span className="small grow">You play</span>
              <span className="seg" role="group" aria-label="Your color">
                {(["w", "b"] as const).map((c) => (
                  <button key={c} aria-pressed={you === c} onClick={() => send({ type: "setColor", color: c })}>
                    {c === "w" ? "White" : "Black"}
                  </button>
                ))}
              </span>
            </div>
            <div className="row">
              <label className="switch grow">
                <input type="checkbox" role="switch" checked={state.chessappHints} onChange={(e) => send({ type: "chessappHints", on: e.target.checked })} />
                Live hints
              </label>
              {!g.finished && (
                <button className="btn" onClick={() => send({ type: "endChessAppGame" })}>
                  End game and review
                </button>
              )}
            </div>
            <p className="muted small prose">Turn hints off for Game Center games. Tempo can't tell them apart from computer games.</p>
          </div>
        )}

        {state.review && <ReviewProgress review={state.review} />}
      </div>
    </div>
  );
}
