"use client";

import { useEffect, useMemo, useState } from "react";
import { Chess } from "chess.js";
import { api, type DrillRow } from "./api";
import { Board } from "./Board";
import { GradeTag } from "./ui";

interface Result {
  correct: boolean;
  bestSan: string;
  explanation: string;
  takeaway: string;
  played: string;
  uci: string;
}

export function Drills({ refreshKey }: { refreshKey: number }) {
  const [drills, setDrills] = useState<DrillRow[] | null>(null);
  const [i, setI] = useState(0);
  const [fen, setFen] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    api<DrillRow[]>("/api/drills")
      .then((d) => {
        setErr(false);
        setDrills(d);
        setI(0);
      })
      .catch(() => setErr(true));
  }, [refreshKey, attempt]);

  const drill = drills?.[i];
  useEffect(() => {
    setFen(drill?.fen ?? null);
    setResult(null);
  }, [drill]);

  const side = useMemo(() => (drill && new Chess(drill.fen).turn() === "b" ? "black" : "white"), [drill]);

  if (err) {
    return (
      <div className="card empty">
        <h2 className="title">Couldn't reach the daemon.</h2>
        <p className="muted prose">
          Check that <code>pnpm dev</code> is still running.
        </p>
        <button className="btn" onClick={() => setAttempt((a) => a + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (!drills) {
    return (
      <div className="drill" aria-busy="true" aria-label="Loading drills">
        <div className="stage">
          <div className="skeleton" style={{ aspectRatio: "1" }} />
        </div>
        <div className="skeleton" style={{ height: 160 }} />
      </div>
    );
  }
  if (!drill) {
    return (
      <div className="card empty">
        <h2 className="title">No drills due</h2>
        <p className="muted prose">Positions where you went wrong come back here as puzzles. Solve one and it returns after 2 days, then 4, then 8. Miss it and it's back in 10 minutes.</p>
      </div>
    );
  }

  const onDrop = ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) => {
    if (!targetSquare || result || busy || !fen) return false;
    const c = new Chess(fen);
    let mv;
    try {
      mv = c.move({ from: sourceSquare, to: targetSquare, promotion: "q" });
    } catch {
      return false;
    }
    setFen(c.fen());
    setBusy(true);
    const uci = mv.from + mv.to + (mv.promotion ?? "");
    api<Omit<Result, "played" | "uci">>(`/api/drills/${drill.id}/attempt`, { method: "POST", body: JSON.stringify({ uci }) })
      .then((r) => setResult({ ...r, played: mv.san, uci }))
      .catch(() => setErr(true))
      .finally(() => setBusy(false));
    return true;
  };

  const next = () => {
    if (i + 1 < drills.length) setI(i + 1);
    else setAttempt((a) => a + 1);
  };

  return (
    <div className="drill">
      <div className="stage">
        <Board
          id="drill"
          fen={fen ?? drill.fen}
          orientation={side}
          lastMove={result?.uci}
          arrows={result && !result.correct ? [{ uci: drill.bestUci, tone: "best" }] : []}
          onDrop={result || busy ? undefined : onDrop}
        />
      </div>

      <div className="stack">
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">
              Drill {i + 1} of {drills.length}
            </h3>
            <span className="steps" style={{ width: Math.min(drills.length, 10) * 28 }} aria-hidden="true">
              {drills.slice(0, 10).map((d, k) => (
                <span key={d.id} className={k === i ? "on" : k < i ? "done" : ""} />
              ))}
            </span>
          </div>
          <h2 className="title">{side === "white" ? "White" : "Black"} to move. Find the better move.</h2>
          <p className="prose">
            <span className="muted">From your {drill.phase}. You played</span> <b>{drill.playedSan}</b> <GradeTag grade={drill.grade} />
          </p>
          {!result && <p className="muted small">{busy ? "Checking your move." : "Drag a piece to answer."}</p>}
        </div>

        {result && (
          <div className="card explain" role="status">
            <div className="lastmove">
              <span className="san">{result.played}</span>
              <span className="tag">
                <span className={`mark ${result.correct ? "best" : "blunder"}`} />
                {result.correct ? "Correct" : "Not the move"}
              </span>
              {!result.correct && (
                <span className="small">
                  <span className="muted">Best was</span> <b>{result.bestSan}</b>
                </span>
              )}
            </div>
            {result.explanation && <p className="prose">{result.explanation}</p>}
            {result.takeaway && (
              <div className="rule">
                <span className="label">Rule</span>
                <p className="prose">{result.takeaway}</p>
              </div>
            )}
            <div className="row tight">
              <button className="btn primary" onClick={next}>
                Next drill
              </button>
              <button
                className="btn"
                onClick={() => {
                  setFen(drill.fen);
                  setResult(null);
                }}
              >
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
