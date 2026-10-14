"use client";

import { useEffect, useRef, useState } from "react";
import { PAWNS_TIP, standing, useHub, whiteShare, type Explanation, type HubMessage, type LiveState } from "../_components/api";
import { Board } from "../_components/Board";
import { ExplainBody, GradeTag, isError, moveName, sq } from "../_components/ui";

const TIERS = ["Plan", "Piece", "Move"];

type Bridge = { postMessage: (m: unknown) => void };

/** The native overlay shell (tempo-overlay), when this page is running inside it. */
function bridge(): Bridge | undefined {
  return (window as unknown as { webkit?: { messageHandlers?: { tempo?: Bridge } } }).webkit?.messageHandlers?.tempo;
}

function turnText(connected: boolean, s: LiveState | null): string {
  if (!connected || !s) return "Offline";
  const g = s.game;
  if (!g) return "No Game";
  if (g.finished) return `Game Over · ${g.result}`;
  if (!s.live.allowed) return "Hints Off";
  if (s.thinking) return "Thinking";
  return g.yourTurn ? "Your Move" : "Their Move";
}

/**
 * Compact coach that floats over the game. Inside tempo-overlay it reports its height and the hint marks
 * to the shell, which draws them on Chess.app's real board. For Lichess it shows the hint on a small board.
 */
export default function OverlayPage() {
  const ref = useRef<HTMLDivElement>(null);
  const [native, setNative] = useState(true);
  const [state, setState] = useState<LiveState | null>(null);
  const [explanation, setExplanation] = useState<{ e: Explanation; fen: string | null } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fenRef = useRef<string | null>(null);

  const { connected, send } = useHub((m: HubMessage) => {
    if (m.type === "state") {
      fenRef.current = m.state.game?.fen ?? null;
      setState(m.state);
    } else if (m.type === "explain") {
      setExplanation({ e: m.explanation, fen: fenRef.current });
      setExplaining(false);
    } else if (m.type === "error") {
      setError(m.message);
      setExplaining(false);
    }
  });

  const g = state?.game ?? null;
  const live = !!g && !!state?.live.allowed;
  const tier = live ? state!.hints.length : 0;
  const square = tier >= 2 ? (state!.hints[1]?.square ?? null) : null;
  const arrow = tier >= 3 ? (state!.hints[2]?.uci ?? null) : null;
  const lg = live ? state!.lastGrade : null;
  const st = live && state!.eval ? standing(state!.eval.score, g!.playerColor) : null;
  const h1 = tier >= 1 ? state!.hints[0] : undefined;
  const h3 = tier >= 3 ? state!.hints[2] : undefined;
  // The whole recommendation at once: strategy, plan, the move, and a diagram of the line.
  const rec =
    h1 && h3 && h3.uci
      ? {
          strategy: h1.strategy ?? null,
          plan: h1.text,
          move: h3.text,
          why: h3.why ?? null,
          from: h3.uci.slice(0, 2),
          keySquares: h1.keySquares ?? [],
          arrows: (h3.pv ?? [h3.uci]).slice(0, 3).map((uci, i) => ({ uci, tone: (["hint", "reply", "follow"] as const)[i]! })),
        }
      : null;
  const shownExplanation = explanation && explanation.fen === (g?.fen ?? null) ? explanation : null;

  useEffect(() => setNative(!!bridge()), []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => bridge()?.postMessage({ height: Math.ceil(el.getBoundingClientRect().height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    bridge()?.postMessage({ source: g?.source ?? null, active: !!g && !g.finished, square, arrow });
  }, [g?.source, g?.finished, !!g, square, arrow]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);

  return (
    <div className={`hud${native ? "" : " standalone"}`} ref={ref}>
      <section>
        <div className="hud-head">
          {st ? (
            <>
              <span className="word" title={st.pawns ? `${PAWNS_TIP} (${st.pawns})` : undefined}>
                {st.words}
              </span>
            </>
          ) : (
            <span className="word">Tempo</span>
          )}
          <span className="turn">
            {live && g!.yourTurn && !g!.finished && <span className="dot ok" />}
            {turnText(connected, state)}
          </span>
        </div>
        {st && (
          <div className="meter-wrap">
            <div className="meter" role="img" aria-label={`Your winning chances ${Math.round(st.share * 100)}%`}>
              <div style={{ transform: `scaleX(${st.share})` }} />
            </div>
            <span className="ends">
              <span>You</span>
              <span>{g!.source === "chessapp" ? "Computer" : "Them"}</span>
            </span>
          </div>
        )}
        {state?.opening && <span className="muted small">{state.opening}</span>}
        {state && g && !state.live.allowed && <span className="muted">{sq(state.live.reason)}</span>}
      </section>

      {lg && (
        <section>
          <span className="label">Your Last Move</span>
          <div className="lastmove">
            <span className="played">{moveName(lg.san)}</span>
            <GradeTag grade={lg.grade} />
          </div>
          {isError(lg.grade) && lg.bestSan && (
            <span>
              <span className="muted">Better was</span> <b>{moveName(lg.bestSan)}</b>
            </span>
          )}
          {isError(lg.grade) && (lg.why ? <p className="why">{sq(lg.why)}</p> : <p className="why pending">Working out why…</p>)}
        </section>
      )}

      {rec && (
        <section className="coach">
          <span className="label">Strategy</span>
          <span className="strategy">{rec.strategy ?? "Working it out…"}</span>
          <p>{sq(rec.plan)}</p>

          <span className="label">Play</span>
          <span className="played">{moveName(rec.move)}</span>
          {rec.why && <p>{sq(rec.why)}</p>}

          <figure className="plan-figure">
            <Board
              id="hud"
              fen={g!.fen}
              orientation={g!.playerColor === "w" ? "white" : "black"}
              lastMove={null}
              highlight={rec.from}
              marks={rec.keySquares}
              arrows={rec.arrows}
            />
            <figcaption className="legend">
              <span>
                <i className="key k-move" /> Your move
              </span>
              {rec.arrows.some((x) => x.tone === "reply") && (
                <span>
                  <i className="key k-reply" /> Likely reply
                </span>
              )}
              {rec.arrows.some((x) => x.tone === "follow") && (
                <span>
                  <i className="key k-follow" /> Your next move
                </span>
              )}
              {rec.keySquares.length > 0 && (
                <span>
                  <i className="key k-ring" /> Target squares
                </span>
              )}
            </figcaption>
          </figure>
        </section>
      )}

      {shownExplanation && (
        <section>
          <ExplainBody e={shownExplanation.e} />
        </section>
      )}

      {g && g.san.length > 0 && (
        <section className="fill">
          <span className="label">Moves</span>
          <ol className="movelog">
            {g.san.map((m, i) => {
              // The side that moved last is the one not on move now.
              const lastByYou = !g.yourTurn;
              const byYou = (g.san.length - 1 - i) % 2 === 0 ? lastByYou : !lastByYou;
              return (
                <li key={i} aria-current={i === g.san.length - 1}>
                  <span className="who">{byYou ? "You" : g.source === "chessapp" ? "Computer" : "Them"}</span>
                  {moveName(m)}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {live && !g!.finished && (
        <section className="foot">
          <div className={tier >= 3 ? "" : "actions"} style={tier >= 3 ? { display: "grid" } : undefined}>
            {tier < 3 && (
              <button className="btn primary" disabled={!g!.yourTurn || state!.thinking} onClick={() => send({ type: "hint" })}>
                Coach Me
              </button>
            )}
            <button
              className="btn"
              disabled={explaining || tier < 3}
              aria-busy={explaining}
              onClick={() => {
                setExplaining(true);
                send({ type: "explain" });
              }}
            >
              Explain More
            </button>
          </div>
          {error && (
            <span className="small muted" role="status">
              {error}
            </span>
          )}
        </section>
      )}
    </div>
  );
}
