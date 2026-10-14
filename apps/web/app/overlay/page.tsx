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

function statusText(connected: boolean, s: LiveState | null): string {
  if (!connected || !s) return "Daemon offline";
  const g = s.game;
  if (!g) return "Waiting for a game";
  if (g.finished) return `Game over · ${g.result}`;
  if (!s.live.allowed) return s.live.reason;
  if (s.thinking) return "Analysing";
  return g.yourTurn ? "Your move" : "Their move";
}

/**
 * Compact coach that floats over the game. Inside tempo-overlay it reports its height and the hint marks
 * to the shell, which draws them on Chess.app's real board. For Lichess it shows the hint on a small board.
 */
export default function OverlayPage() {
  const ref = useRef<HTMLDivElement>(null);
  const [native, setNative] = useState(true);
  const [state, setState] = useState<LiveState | null>(null);
  const [explanation, setExplanation] = useState<{ e: Explanation; about: string; fen: string | null } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fenRef = useRef<string | null>(null);

  const { connected, send } = useHub((m: HubMessage) => {
    if (m.type === "state") {
      fenRef.current = m.state.game?.fen ?? null;
      setState(m.state);
    } else if (m.type === "explain") {
      setExplanation({ e: m.explanation, about: m.about, fen: fenRef.current });
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
    bridge()?.postMessage({ source: g?.source ?? null, square, arrow });
  }, [g?.source, square, arrow]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);

  return (
    <div className={`hud${native ? "" : " standalone"}`} ref={ref}>
      <div className="hud-head">
        {live && state!.eval && (
          <span className="standing">
            <b>{standing(state!.eval.score, g!.playerColor).words}</b>
            <span className="muted small nums" title={PAWNS_TIP}>
              {standing(state!.eval.score, g!.playerColor).pawns}
            </span>
          </span>
        )}
        <span className="grow small">{statusText(connected, state)}</span>
        {live && (
          <span className="pips" role="img" aria-label={`Hint level ${tier} of 3`}>
            {TIERS.map((t, i) => (
              <span key={t} className={i < tier ? "on" : ""} />
            ))}
          </span>
        )}
      </div>

      {lg && (
        <div className="lastmove">
          <b>{lg.san}</b>
          <GradeTag grade={lg.grade} />
          {isError(lg.grade) && lg.bestSan && (
            <span className="small">
              <span className="muted">Best</span> <b>{lg.bestSan}</b>
            </span>
          )}
        </div>
      )}

      {tier > 0 && (
        <ol className="hints">
          {state!.hints.map((h) => (
            <li key={h.tier} className="hint">
              <span className="label">{TIERS[h.tier - 1]}</span>
              {h.text}
              {h.line && <span className="muted small">Then {h.line}</span>}
            </li>
          ))}
        </ol>
      )}

      {/* A browser doesn't expose Lichess's board, so the hint is drawn on a copy of the position. */}
      {live && g!.source === "lichess" && tier >= 2 && (
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

      {live && (
        <div className="row tight">
          <button className="btn primary grow" disabled={!g!.yourTurn || tier >= 3 || state!.thinking} onClick={() => send({ type: "hint" })}>
            {tier === 0 ? "Hint" : tier < 3 ? "Bigger Hint" : "No More Hints"}
          </button>
          <button
            className="btn grow"
            disabled={explaining || (tier < 3 && !lg)}
            aria-busy={explaining}
            onClick={() => {
              setExplaining(true);
              send({ type: "explain" });
            }}
          >
            {tier >= 3 ? "Why?" : "Explain"}
          </button>
        </div>
      )}

      {shownExplanation && (
        <div className="rule">
          <span className="label">On {shownExplanation.about}</span>
          <ExplainBody e={shownExplanation.e} />
        </div>
      )}

      {error && (
        <p className="small" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
