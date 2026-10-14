"use client";

import { useEffect, useRef, useState } from "react";
import { PAWNS_TIP, standing, useHub, whiteShare, type Explanation, type HubMessage, type LiveState } from "../_components/api";
import { Board } from "../_components/Board";
import { ExplainBody, GradeTag, isError } from "../_components/ui";

const TIERS = ["Idea", "Piece", "Move"];

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
  const square = tier === 2 ? (state!.hints[1]?.square ?? null) : null;
  const arrow = tier >= 3 ? (state!.hints[2]?.uci ?? null) : null;
  const lg = live ? state!.lastGrade : null;
  const st = live && state!.eval ? standing(state!.eval.score, g!.playerColor) : null;
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
              <span className="word">{st.words}</span>
              <span className="muted nums" title={PAWNS_TIP}>
                {st.pawns}
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
          <div className="meter" role="img" aria-label={`Your winning chances ${Math.round(st.share * 100)}%`}>
            <div style={{ transform: `scaleX(${st.share})` }} />
          </div>
        )}
        {state && g && !state.live.allowed && <span className="muted">{state.live.reason}</span>}
      </section>

      {lg && (
        <section>
          <div className="lastmove">
            <span className="san">{lg.san}</span>
            <GradeTag grade={lg.grade} />
            {isError(lg.grade) && lg.bestSan && (
              <span className="small" style={{ marginLeft: "auto" }}>
                <span className="muted">Best</span> <b>{lg.bestSan}</b>
              </span>
            )}
          </div>
          {isError(lg.grade) && (lg.why ? <p className="why">{lg.why}</p> : <p className="why pending">Working out why…</p>)}
        </section>
      )}

      {tier > 0 && (
        <section>
          {state!.hints.map((h) => (
            <div key={h.tier} className="step">
              <span className="label">{TIERS[h.tier - 1]}</span>
              {h.tier === 3 ? (
                <span>
                  <span className="move">{h.text}</span>
                  {h.line && <span className="muted small"> then {h.line}</span>}
                </span>
              ) : (
                <span>{h.text}</span>
              )}
            </div>
          ))}
          {/* A browser doesn't expose Lichess's board, so the hint is drawn on a copy of the position. */}
          {g!.source === "lichess" && tier >= 2 && (
            <Board
              id="hud"
              fen={g!.fen}
              orientation={g!.playerColor === "w" ? "white" : "black"}
              whiteShare={state!.eval ? whiteShare(state!.eval.score) : null}
              lastMove={g!.lastMove}
              highlight={square}
              arrows={arrow ? [{ uci: arrow, tone: "hint" }] : []}
            />
          )}
        </section>
      )}

      {shownExplanation && (
        <section>
          <ExplainBody e={shownExplanation.e} />
        </section>
      )}

      {live && !g!.finished && (
        <section>
          <div className="actions">
            <button className="btn primary" disabled={!g!.yourTurn || tier >= 3 || state!.thinking} onClick={() => send({ type: "hint" })}>
              {tier === 0 ? "Hint" : tier < 3 ? "Next Hint" : "All Hints Shown"}
            </button>
            <button
              className="btn"
              disabled={explaining || tier < 3}
              aria-busy={explaining}
              onClick={() => {
                setExplaining(true);
                send({ type: "explain" });
              }}
            >
              Why This Move
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
