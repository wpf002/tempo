"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { useHub, type Explanation, type HubMessage, type LiveState } from "./_components/api";
import { Live } from "./_components/Live";
import { Review } from "./_components/Review";
import { Stats } from "./_components/Stats";
import { Drills } from "./_components/Drills";
import { Logo, StatusDot, sourceName } from "./_components/ui";

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

  const pick = (t: Tab) => {
    setTab(t);
    if (t !== "Live") setRefreshKey((k) => k + 1);
  };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const t = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length]!;
    pick(t);
    document.getElementById(`tab-${t}`)?.focus();
  };

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <Logo />
            Tempo
          </div>
          <div className="tabs" role="tablist" aria-label="Sections" onKeyDown={onTabKey}>
            {TABS.map((t) => (
              <button key={t} id={`tab-${t}`} className="tab" role="tab" aria-selected={tab === t} aria-controls="panel" tabIndex={tab === t ? 0 : -1} onClick={() => pick(t)}>
                {t}
              </button>
            ))}
          </div>
          <div className="status">
            {connected &&
              state?.sources.map((s) => (
                <span key={s.source} className="status-item" title={`${sourceName(s.source)}: ${s.detail || s.state}`}>
                  <StatusDot state={s.state} />
                  <span className="text">{sourceName(s.source)}</span>
                  <span className="sr-only">{s.state}</span>
                </span>
              ))}
            <span className="status-item">
              <span className={`dot ${connected ? "ok" : "bad"}`} />
              <span className="text">{connected ? "Connected" : "Daemon offline"}</span>
            </span>
          </div>
        </div>
      </header>

      <main className="content" id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {!connected && state && (
          <div className="banner" role="status">
            <span className="dot bad" />
            Lost the connection to the daemon. Reconnecting.
          </div>
        )}
        {tab === "Live" && (
          <Live
            state={state}
            connected={connected}
            send={send}
            explanation={explanation}
            explaining={explaining}
            onExplain={() => {
              setExplaining(true);
              send({ type: "explain" });
            }}
          />
        )}
        {tab === "Review" && <Review refreshKey={refreshKey} reviewing={state?.review ?? null} />}
        {tab === "Stats" && <Stats refreshKey={refreshKey} />}
        {tab === "Drills" && <Drills refreshKey={refreshKey} />}
      </main>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}
