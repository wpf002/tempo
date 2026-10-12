"use client";

import { useEffect, useMemo, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { api, type DrillRow } from "./api";

interface Result {
  correct: boolean;
  bestSan: string;
  explanation: string;
  takeaway: string;
  played: string;
}

export function Drills({ refreshKey }: { refreshKey: number }) {
  const [drills, setDrills] = useState<DrillRow[] | null>(null);
  const [i, setI] = useState(0);
  const [fen, setFen] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    api<DrillRow[]>("/api/drills")
      .then((d) => {
        setDrills(d);
        setI(0);
      })
      .catch(() => setErr(true));
  }, [refreshKey]);

  const drill = drills?.[i];
  useEffect(() => {
    setFen(drill?.fen ?? null);
    setResult(null);
  }, [drill]);

  const orientation = useMemo(() => (drill ? (new Chess(drill.fen).turn() === "w" ? "white" : "black") : "white"), [drill]);

  if (err) return <div className="card muted">Couldn't reach the daemon.</div>;
  if (!drills) return <div className="card muted">Loading…</div>;
  if (!drill) return <div className="card muted">No drills due. Mistakes from reviewed games come back here on a spaced schedule.</div>;

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
    api<Omit<Result, "played">>(`/api/drills/${drill.id}/attempt`, { method: "POST", body: JSON.stringify({ uci }) })
      .then((r) => setResult({ ...r, played: mv.san }))
      .catch(() => setErr(true))
      .finally(() => setBusy(false));
    return true;
  };

  const next = () => {
    if (i + 1 < drills.length) setI(i + 1);
    else api<DrillRow[]>("/api/drills").then((d) => { setDrills(d); setI(0); }).catch(() => setErr(true));
  };

  return (
    <div className="reviewgrid">
      <div className="board">
        <Chessboard options={{
          id: "drill",
          position: fen ?? drill.fen,
          boardOrientation: orientation,
          allowDragging: !result && !busy,
          onPieceDrop: onDrop,
          darkSquareStyle: { backgroundColor: "var(--sq-dark)" },
          lightSquareStyle: { backgroundColor: "var(--sq-light)" },
          arrows: result && !result.correct ? [{ startSquare: drill.bestUci.slice(0, 2), endSquare: drill.bestUci.slice(2, 4), color: "rgba(111,191,115,0.85)" }] : [],
        }} />
      </div>
      <div>
        <div className="card">
          <h3>Drill {i + 1} of {drills.length} · from your {drill.phase}</h3>
          <p style={{ marginTop: 0 }}>
            You played <b className="mono">{drill.playedSan}</b> here ({drill.grade}). {orientation === "white" ? "White" : "Black"} to move. Find the better move.
          </p>
          {busy && <p className="muted">Checking…</p>}
          {result && (
            <>
              <p>
                <span className={`grade ${result.correct ? "g-best" : "g-blunder"}`}>{result.correct ? "correct" : "not quite"}</span>{" "}
                <span className="mono">{result.played}</span>
                {!result.correct && <> · best was <b className="mono">{result.bestSan}</b></>}
              </p>
              {result.explanation && <p>{result.explanation}</p>}
              {result.takeaway && <p className="muted">{result.takeaway}</p>}
              <div className="row">
                <button className="btn" onClick={() => { setFen(drill.fen); setResult(null); }}>Try again</button>
                <button className="btn primary" onClick={next}>Next</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
