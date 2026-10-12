"use client";

import { useEffect, useState } from "react";
import { useHub, type Explanation, type HubMessage, type LiveState } from "./_components/api";
import { Live } from "./_components/Live";
import { Review } from "./_components/Review";
import { Stats } from "./_components/Stats";
import { Drills } from "./_components/Drills";

const TABS = ["Live", "Review", "Stats", "Drills"] as const;
type Tab = (typeof TABS)[number];

export default function Page() {
  const [tab, setTab] = useState<Tab>("Live");
  const [state, setState] = useState<LiveState | null>(null);
  const [explanation, setExplanation] = useState<{ e: Explanation; about: string } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [fen, setFen] = useState<string | null>(null);

  const { connected, send } = useHub((m: HubMessage) => {
    if (m.type === "state") setState(m.state);
    else if (m.type === "explain") {
      setExplanation({ e: m.explanation, about: m.about });
      setExplaining(false);
    } else if (m.type === "error") {
      setToast(m.message);
      setExplaining(false);
    } else if (m.type === "reviewDone") {
      setRefreshKey((k) => k + 1);
      setToast("Review ready. Open the Review tab.");
    }
  });

  // Clear stale explanations when the position changes.
  useEffect(() => {
    const f = state?.game?.fen ?? null;
    if (f !== fen) {
      setFen(f);
      if (fen !== null) setExplanation(null);
    }
  }, [state?.game?.fen, fen]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <main className="shell">
      <div className="top">
        <div className="brand">Tem<span>po</span></div>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); if (t !== "Live") setRefreshKey((k) => k + 1); }}>
              {t}
            </button>
          ))}
        </div>
        <span className={`conn ${connected ? "ok" : "bad"}`}>{connected ? "daemon" : "daemon offline"}</span>
      </div>

      {tab === "Live" && (
        <Live
          state={state}
          send={send}
          explanation={explanation}
          explaining={explaining}
          onExplain={() => {
            setExplaining(true);
            send({ type: "explain" });
          }}
        />
      )}
      {tab === "Review" && <Review refreshKey={refreshKey} />}
      {tab === "Stats" && <Stats refreshKey={refreshKey} />}
      {tab === "Drills" && <Drills refreshKey={refreshKey} />}

      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
