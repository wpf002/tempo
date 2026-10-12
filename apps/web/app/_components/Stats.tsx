"use client";

import { useEffect, useState } from "react";
import { api, type Stats as S } from "./api";

export function Stats({ refreshKey }: { refreshKey: number }) {
  const [s, setS] = useState<S | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    api<S>("/api/stats").then(setS).catch(() => setErr(true));
  }, [refreshKey]);

  if (err) return <div className="card muted">Couldn't reach the daemon.</div>;
  if (!s) return <div className="card muted">Loading…</div>;
  if (!s.games) return <div className="card muted">Stats show up after your first reviewed game.</div>;

  const max = Math.max(1, ...s.byMotif.map((m) => m.count));
  const phases = ["opening", "middlegame", "endgame"];
  const grades = ["inaccuracy", "mistake", "blunder"];
  const cell = (p: string, g: string) => s.byPhase.find((x) => x.phase === p && x.grade === g)?.count ?? 0;
  const t = s.accuracyTrend;

  return (
    <div>
      <div className="row" style={{ gap: 12, alignItems: "stretch" }}>
        <div className="card grow">
          <h3>Games reviewed</h3>
          <div className="big">{s.games}</div>
        </div>
        <div className="card grow">
          <h3>Average accuracy</h3>
          <div className="big">{s.avgAccuracy?.toFixed(0) ?? "–"}%</div>
        </div>
      </div>

      {t.length > 1 && (
        <div className="card">
          <h3>Accuracy, last {t.length} games</h3>
          <svg viewBox="0 0 400 90" width="100%" role="img" aria-label="Accuracy trend">
            <polyline
              fill="none"
              stroke="#d9a441"
              strokeWidth="2"
              points={t.map((p, i) => `${(i / (t.length - 1)) * 400},${90 - (p.accuracy / 100) * 86 - 2}`).join(" ")}
            />
          </svg>
        </div>
      )}

      <div className="card">
        <h3>What you keep getting wrong</h3>
        <div className="bars">
          {s.byMotif.map((m) => (
            <div className="bar" key={m.motif}>
              <span>{m.motif}</span>
              <div className="track"><div className="fill" style={{ width: `${(100 * m.count) / max}%` }} /></div>
              <span className="mono muted">{m.count}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Errors by phase</h3>
        <table className="mono" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr className="muted">
              <th style={{ textAlign: "left", fontWeight: 400 }}>phase</th>
              {grades.map((g) => <th key={g} style={{ textAlign: "right", fontWeight: 400, color: `var(--${g})` }}>{g}</th>)}
            </tr>
          </thead>
          <tbody>
            {phases.map((p) => (
              <tr key={p}>
                <td>{p}</td>
                {grades.map((g) => <td key={g} style={{ textAlign: "right" }}>{cell(p, g)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
