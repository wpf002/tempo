"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { fmt, whiteShare, type MoveRow, type Stats } from "./api";

/** Charts are drawn in real pixels so strokes and markers don't stretch with the container. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Index of the data point nearest the pointer. */
function nearest(e: PointerEvent<SVGSVGElement>, x0: number, x1: number, n: number): number {
  const r = e.currentTarget.getBoundingClientRect();
  const t = (e.clientX - r.left - x0) / Math.max(1, x1 - x0);
  return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
}

function tipStyle(x: number, width: number) {
  // Flip to the left of the crosshair near the right edge so the tooltip stays inside the chart.
  return x > width / 2 ? { right: width - x + 8 } : { left: x + 8 };
}

/**
 * Evaluation over the game as White's winning share, drawn around the 50% line.
 * Click to jump to a position. The move list is the table view of the same data.
 */
export function EvalGraph({ moves, ply, onPick }: { moves: MoveRow[]; ply: number; onPick: (p: number) => void }) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const H = 96;
  const PAD = 4;
  const pts = moves.length ? [whiteShare(moves[0]!.evalBefore), ...moves.map((m) => whiteShare(m.evalAfter))] : [];
  const n = pts.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * width : 0);
  const y = (v: number) => PAD + (1 - v) * (H - 2 * PAD);
  const mid = y(0.5);
  const line = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const at = hover ?? null;
  const hovered = at !== null && at > 0 ? moves[at - 1] : null;

  return (
    <div className="chart" ref={ref} style={{ height: H }}>
      {width > 0 && n > 1 && (
        <svg
          width={width}
          height={H}
          role="img"
          aria-label={`Evaluation over the game. Showing position ${ply} of ${n - 1}.`}
          style={{ cursor: "pointer" }}
          onPointerMove={(e) => setHover(nearest(e, 0, width, n))}
          onPointerLeave={() => setHover(null)}
          onClick={(e) => onPick(nearest(e as unknown as PointerEvent<SVGSVGElement>, 0, width, n))}
        >
          <line x1={0} x2={width} y1={mid} y2={mid} stroke="var(--border)" strokeWidth={1} />
          <path d={`${line} L${width},${mid} L0,${mid} Z`} fill="var(--text)" opacity={0.1} />
          <path d={line} fill="none" stroke="var(--text)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <line x1={x(ply)} x2={x(ply)} y1={0} y2={H} stroke="var(--accent)" strokeWidth={2} />
          {at !== null && at !== ply && <line x1={x(at)} x2={x(at)} y1={0} y2={H} stroke="var(--border-strong)" strokeWidth={1} />}
          {moves.map((m) =>
            m.grade === "mistake" || m.grade === "blunder" ? (
              <circle key={m.ply} cx={x(m.ply)} cy={y(pts[m.ply]!)} r={4} fill={`var(--${m.grade})`} stroke="var(--surface)" strokeWidth={2} />
            ) : null,
          )}
        </svg>
      )}
      {at !== null && (
        <div className="tip" style={tipStyle(x(at), width)}>
          <b>{hovered ? fmt(hovered.evalAfter) : moves[0] ? fmt(moves[0].evalBefore) : ""}</b>
          <span className="muted">
            {hovered ? `${Math.ceil(hovered.ply / 2)}${hovered.color === "w" ? "." : "…"} ${hovered.san}${hovered.grade === "good" ? "" : ` · ${hovered.grade}`}` : "Start"}
          </span>
        </div>
      )}
    </div>
  );
}

/** Accuracy per reviewed game, oldest to newest. */
export function TrendChart({ points }: { points: Stats["accuracyTrend"] }) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const H = 176;
  const L = 32;
  const R = 48;
  const T = 8;
  const B = 24;
  const n = points.length;
  // Start the scale at the tens below the lowest game so the line uses the plot height.
  const lo = Math.max(0, Math.min(50, Math.floor(Math.min(...points.map((p) => p.accuracy)) / 10) * 10));
  const ticks = [lo, (lo + 100) / 2, 100];
  const x = (i: number) => L + (n > 1 ? (i / (n - 1)) * (width - L - R) : 0);
  const y = (v: number) => T + (1 - (v - lo) / (100 - lo)) * (H - T - B);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.accuracy).toFixed(1)}`).join(" ");
  const last = points[n - 1]!;
  const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const at = hover === null ? null : points[hover]!;

  return (
    <div className="chart" ref={ref} style={{ height: H }}>
      {width > 0 && (
        <svg
          width={width}
          height={H}
          role="img"
          aria-label={`Accuracy over the last ${n} reviewed games. Latest ${last.accuracy.toFixed(0)} percent.`}
          onPointerMove={(e) => setHover(nearest(e, L, width - R, n))}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={L} x2={width - R} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
              <text x={L - 8} y={y(t)} textAnchor="end" dominantBaseline="middle">
                {t}
              </text>
            </g>
          ))}
          <text x={L} y={H - 4}>
            {day(points[0]!.startedAt)}
          </text>
          <text x={width - R} y={H - 4} textAnchor="end">
            {day(last.startedAt)}
          </text>
          <path d={`${line} L${x(n - 1)},${y(lo)} L${x(0)},${y(lo)} Z`} fill="var(--series)" opacity={0.1} />
          <path d={line} fill="none" stroke="var(--series)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="var(--border-strong)" strokeWidth={1} />}
          {hover !== null && hover !== n - 1 && <circle cx={x(hover)} cy={y(at!.accuracy)} r={4} fill="var(--series)" stroke="var(--surface)" strokeWidth={2} />}
          <circle cx={x(n - 1)} cy={y(last.accuracy)} r={4} fill="var(--series)" stroke="var(--surface)" strokeWidth={2} />
          <text x={x(n - 1) + 8} y={y(last.accuracy)} dominantBaseline="middle" style={{ fill: "var(--text)", fontWeight: 500 }}>
            {last.accuracy.toFixed(0)}%
          </text>
        </svg>
      )}
      {at && (
        <div className="tip" style={tipStyle(x(hover!), width)}>
          <b>{at.accuracy.toFixed(0)}%</b>
          <span className="muted">{day(at.startedAt)}</span>
        </div>
      )}
      <table className="sr-only">
        <caption>Accuracy by game</caption>
        <thead>
          <tr>
            <th>Date</th>
            <th>Accuracy</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.id}>
              <td>{day(p.startedAt)}</td>
              <td>{p.accuracy.toFixed(0)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
