"use client";

import { useEffect, useState } from "react";
import { api, type Grade, type Stats as S } from "./api";
import { TrendChart } from "./charts";
import { GradeTag } from "./ui";

const PHASES = ["opening", "middlegame", "endgame"];
const GRADES: Grade[] = ["inaccuracy", "mistake", "blunder"];

export function Stats({ refreshKey }: { refreshKey: number }) {
  const [s, setS] = useState<S | null>(null);
  const [err, setErr] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    api<S>("/api/stats")
      .then((r) => {
        setErr(false);
        setS(r);
      })
      .catch(() => setErr(true));
  }, [refreshKey, attempt]);

  if (err) {
    return (
      <div className="card empty">
        <h2 className="title">Can't Reach the Daemon</h2>
        <p className="muted prose">
          Check that <code>pnpm dev</code> is still running.
        </p>
        <button className="btn" onClick={() => setAttempt((a) => a + 1)}>
          Try Again
        </button>
      </div>
    );
  }
  if (!s) {
    return (
      <div className="stack" aria-busy="true" aria-label="Loading stats">
        <div className="kpis">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 96 }} />
          ))}
        </div>
        <div className="skeleton" style={{ height: 240 }} />
      </div>
    );
  }
  if (!s.games) {
    return (
      <div className="card empty">
        <h2 className="title">No Stats Yet</h2>
        <p className="muted prose">After your first reviewed game this page shows your accuracy over time and the mistakes you repeat, grouped by motif and by phase of the game.</p>
      </div>
    );
  }

  const errors = s.byMotif.reduce((sum, m) => sum + m.count, 0);
  const max = Math.max(1, ...s.byMotif.map((m) => m.count));
  // "other" is what ungraded-by-coach mistakes fall into, so it isn't a pattern worth headlining.
  const top = s.byMotif.find((m) => m.motif !== "other") ?? s.byMotif[0];
  const cell = (p: string, g: string) => s.byPhase.find((x) => x.phase === p && x.grade === g)?.count ?? 0;
  const t = s.accuracyTrend;

  return (
    <div className="stack">
      <div className="kpis">
        <div className="card kpi">
          <h3 className="card-title">Games Reviewed</h3>
          <div className="value">{s.games}</div>
        </div>
        <div className="card kpi">
          <h3 className="card-title">Average Accuracy</h3>
          <div className="value">{s.avgAccuracy != null ? `${s.avgAccuracy.toFixed(0)}%` : "–"}</div>
        </div>
        <div className="card kpi">
          <h3 className="card-title">Mistakes Logged</h3>
          <div className="value">{errors}</div>
        </div>
        <div className="card kpi">
          <h3 className="card-title">Most Repeated</h3>
          <div className="value" title={top?.motif}>
            {top?.motif ?? "–"}
          </div>
        </div>
      </div>

      {t.length > 1 && (
        <div className="card">
          <h3 className="card-title">Accuracy by Game</h3>
          <TrendChart points={t} />
        </div>
      )}

      <div className="cols">
        <div className="card">
          <h3 className="card-title">Repeat Mistakes</h3>
          {s.byMotif.length ? (
            <div className="bars">
              {s.byMotif.map((m) => (
                <div className="row-hit" key={m.motif}>
                  <span className="name">{m.motif}</span>
                  <span className="track">
                    <span className="fill" style={{ width: `${(100 * m.count) / max}%` }} />
                  </span>
                  <span className="n">{m.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted small">No mistakes logged yet.</p>
          )}
        </div>

        <div className="card">
          <h3 className="card-title">Errors by Phase</h3>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Phase</th>
                {GRADES.map((g) => (
                  <th key={g} scope="col">
                    <GradeTag grade={g} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PHASES.map((p) => (
                <tr key={p}>
                  <td>{p}</td>
                  {GRADES.map((g) => {
                    const n = cell(p, g);
                    return (
                      <td key={g} className={n ? "" : "zero"}>
                        {n}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
