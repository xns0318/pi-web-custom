"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatUsageTokens, selectUsageRange, USAGE_RANGES, USAGE_REFRESH_INTERVAL_MS, type UsageRange, type UsageSnapshot, type UsageRow, type UsageTotals } from "@/lib/usage";

const TABS = ["overview", "daily", "models", "projects"] as const;
type Tab = typeof TABS[number];

export function UsagePanel({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<Tab>("overview");
  const [range, setRange] = useState<UsageRange>("30d");
  const [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    let active = true;
    let pending: AbortController | null = null;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    async function load(fresh = false) {
      if (!active || pending) return;
      clearTimeout(pollTimer);
      const controller = new AbortController();
      pending = controller;
      let timedOut = false;
      requestTimer = setTimeout(() => { timedOut = true; controller.abort(); }, 60_000);
      setLoading(true);
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const params = new URLSearchParams({ view: "snapshot", timeZone });
      if (fresh) params.set("refresh", "1");
      try {
        const response = await fetch(`/api/usage?${params}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = await response.json() as UsageSnapshot;
        if (active && !controller.signal.aborted) {
          setSnapshot(next);
          setError(null);
        }
      } catch (reason: unknown) {
        if (!active || (controller.signal.aborted && !timedOut)) return;
        setError(timedOut ? "Timeout" : reason instanceof Error ? reason.message : String(reason));
      } finally {
        clearTimeout(requestTimer);
        pending = null;
        if (active) {
          setLoading(false);
          pollTimer = setTimeout(() => { void load(); }, USAGE_REFRESH_INTERVAL_MS);
        }
      }
    }

    // The server keeps updating with this panel closed or the browser hidden.
    // Here we only pull its cache; manual refresh bypasses that cache immediately.
    // No visibility gate: hidden tabs can sync too (subject to browser throttling).
    const onOnline = () => { void load(); };
    window.addEventListener("online", onOnline);
    void load(refresh > 0);
    return () => {
      active = false;
      clearTimeout(pollTimer);
      clearTimeout(requestTimer);
      pending?.abort();
      window.removeEventListener("online", onOnline);
    };
  }, [refresh]);

  // Every range is already in the same snapshot. Keep the cards/table mounted
  // during local switches and slow refreshes; publish refreshed ranges together.
  const data = snapshot ? selectUsageRange(snapshot, range) : null;
  const exact = (value: number) => value.toLocaleString(locale);
  const compact = formatUsageTokens;
  const money = (value: number) => value > 0 && value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
  const modelLabel = (row: UsageRow) => ["usage.assistantModel", "usage.toolModel", "usage.summaryModel"].includes(row.label) ? t(row.label) : row.label;
  const label = (row: UsageRow, kind: Tab) => kind === "models" ? modelLabel(row) : row.label;
  const breakdown = (usage: UsageTotals) => [
    `${t("session.input")}: ${exact(usage.input)}`,
    `${t("session.output")}: ${exact(usage.output)}`,
    `${t("session.cacheRead")}: ${exact(usage.cacheRead)}`,
    `${t("session.cacheWrite")}: ${exact(usage.cacheWrite)}`,
    `${t("usage.total")}: ${exact(usage.totalTokens)}`,
  ].join("\n");

  function summary(kind: "models" | "projects", rows: UsageRow[]) {
    return (
      <div className="usage-summary">
        <button type="button" onClick={() => setTab(kind)}>{t(`usage.${kind}`)} · {t(`usage.range.${range}`)} →</button>
        <div>
          {rows.slice(0, 3).map((row) => (
            <button key={row.key} type="button" className="usage-chip" title={`${row.detail || row.label}\n${breakdown(row)}`} onClick={() => { setTab(kind); setQuery(""); }}>
              <span>{label(row, kind)}</span><strong>{compact(row.totalTokens)}</strong>
            </button>
          ))}
          {!rows.length && <span>{t("usage.empty")}</span>}
        </div>
      </div>
    );
  }

  function table(rows: UsageRow[]) {
    const max = rows.reduce((value, row) => Math.max(value, row.totalTokens), 1);
    const filtered = tab === "projects" && query.trim()
      ? rows.filter((row) => `${row.label} ${row.detail ?? ""}`.toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale)))
      : rows;
    return (
      <>
        {tab === "projects" && (
          <input className="usage-search" type="search" aria-label={t("usage.searchProjects")} placeholder={t("usage.searchProjects")} value={query} onChange={(event) => setQuery(event.target.value)} />
        )}
        <div className="usage-table-scroll" tabIndex={0} aria-label={t(`usage.${tab}`)}>
          <table className="usage-table">
            <thead><tr>
              <th scope="col">{t(`usage.${tab === "daily" ? "date" : tab === "models" ? "model" : "project"}`)}</th>
              <th scope="col">{t("usage.total")}</th>
              <th scope="col">{t("session.input")}</th>
              <th scope="col">{t("session.output")}</th>
              <th scope="col">{t("session.cacheRead")}</th>
              <th scope="col">{t("session.cacheWrite")}</th>
              <th scope="col">{t("usage.records")}</th>
              <th scope="col">{t("usage.cost")}</th>
            </tr></thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.key}>
                  <th scope="row" title={row.detail || row.label}>
                    <span className="usage-row-name">{label(row, tab)}</span>
                    {tab !== "daily" && row.detail && <small>{row.detail}</small>}
                    <span className="usage-bar" aria-hidden="true"><span style={{ width: `${row.totalTokens / max * 100}%` }} /></span>
                  </th>
                  <td title={exact(row.totalTokens)}><strong>{compact(row.totalTokens)}</strong></td>
                  {[row.input, row.output, row.cacheRead, row.cacheWrite].map((value, index) => <td key={index} title={exact(value)}>{compact(value)}</td>)}
                  <td>{exact(row.records)}</td><td title={`$${row.cost.toFixed(6)}`}>{money(row.cost)}</td>
                </tr>
              ))}
              {!filtered.length && <tr><td colSpan={8} className="usage-empty">{t("usage.empty")}</td></tr>}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  return (
    <section ref={panelRef} role="dialog" aria-label={t("usage.title")} tabIndex={-1} className="usage-panel"
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <header className="usage-header">
        <strong>{t("usage.title")}</strong>
        <div>
          <button className="usage-refresh-button" type="button" onClick={() => setRefresh((value) => value + 1)} disabled={loading}>{t(loading ? "usage.loading" : "usage.refresh")}</button>
          <button type="button" onClick={onClose}>{t("usage.close")}</button>
        </div>
      </header>
      <div className="usage-controls">
        <div ref={tabsRef} role="tablist" aria-label={t("usage.views")} className="usage-tabs" onKeyDown={(event) => {
          const index = TABS.indexOf(tab);
          const next = event.key === "ArrowRight" ? (index + 1) % TABS.length : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length
            : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault();
          setTab(TABS[next]);
          tabsRef.current?.querySelectorAll("button")[next]?.focus();
        }}>
          {TABS.map((key) => <button key={key} type="button" id={`usage-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls="usage-content" tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)}>{t(`usage.${key}`)}</button>)}
        </div>
        <select aria-label={t("usage.range")} value={range} onChange={(event) => setRange(event.target.value as UsageRange)}>
          {USAGE_RANGES.map((key) => <option key={key} value={key}>{t(`usage.range.${key}`)}</option>)}
        </select>
      </div>
      {(error || data?.stale) && <div role="alert" className="usage-error">{t("usage.error")}{error && ` · ${error}`}{data && ` · ${t("usage.stale")}`}</div>}
      {!data && loading && <div role="status" className="usage-empty">{t("usage.loading")}</div>}
      {data && <>
        {(data.coverage.unreadableFiles > 0 || data.coverage.skippedLines > 0) && <div role="status" className="usage-warning">{t("usage.partial", { files: data.coverage.unreadableFiles, lines: data.coverage.skippedLines })}</div>}
        <div id="usage-content" role="tabpanel" aria-labelledby={`usage-tab-${tab}`} aria-busy={loading} tabIndex={0}>
          {tab === "overview" ? <>
            <div className="usage-cards">
              {USAGE_RANGES.map((key) => {
                const usage = data.overview[key];
                return <button type="button" className="usage-card" key={key} aria-pressed={range === key} title={breakdown(usage)} onClick={() => setRange(key)}>
                  <span>{t(`usage.range.${key}`)}</span>
                  <strong title={exact(usage.totalTokens)}>{compact(usage.totalTokens)} <small>tok</small></strong>
                  <span>{t("usage.recordCount", { count: exact(usage.records) })} · {money(usage.cost)}</span>
                  <span>↑ {compact(usage.input)}　↓ {compact(usage.output)}</span>
                  <span>{t("usage.cache")} {compact(usage.cacheRead + usage.cacheWrite)}</span>
                </button>;
              })}
            </div>
            {summary("models", data.models)}
            {summary("projects", data.projects)}
          </> : <>
            <div className="usage-period-total" title={breakdown(data.total)}>
              <span>{t(`usage.range.${range}`)}</span><strong>{compact(data.total.totalTokens)} tok</strong>
              <span>{t("usage.recordCount", { count: exact(data.total.records) })} · {money(data.total.cost)}</span>
            </div>
            {table(data[tab])}
          </>}
        </div>
        <footer className="usage-footer">
          <div>{t("usage.updated", { time: new Date(data.generatedAt).toLocaleString(locale), count: data.coverage.sessions, zone: data.timeZone })}</div>
          <div>{t("usage.autoRefresh", { seconds: USAGE_REFRESH_INTERVAL_MS / 1000 })}</div>
          <div>{t("usage.note")}</div>
          <div>{t("usage.coverage", { count: data.coverage.duplicateRecords })}</div>
        </footer>
      </>}
      <style>{`
        .usage-panel { container-type: inline-size; background: var(--bg-panel); color: var(--text); border: 1px solid var(--border); box-shadow: 0 12px 32px rgba(0,0,0,.13); font-size: 12px; outline: none; }
        .usage-panel button, .usage-panel select, .usage-search { font: inherit; color: var(--text-muted); background: transparent; border: 1px solid var(--border); border-radius: 5px; padding: 5px 9px; }
        .usage-panel button, .usage-panel select { cursor: pointer; }
        .usage-panel button:hover { background: var(--bg-hover); color: var(--text); }
        .usage-panel button:disabled { opacity: .5; cursor: wait; }
        .usage-panel button:focus-visible, .usage-panel select:focus-visible, .usage-panel input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        .usage-header, .usage-controls { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; }
        .usage-header { border-bottom: 1px solid var(--border); }
        .usage-header > div { display: flex; gap: 6px; }
        .usage-panel .usage-refresh-button { min-width: 72px; }
        .usage-controls { flex-wrap: wrap; }
        .usage-controls select { background: var(--bg-panel); }
        .usage-tabs { display: flex; gap: 3px; }
        .usage-tabs button { border-color: transparent; }
        .usage-tabs button[aria-selected=true] { background: var(--bg-selected); color: var(--text); font-weight: 600; }
        .usage-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 0 14px 12px; }
        .usage-panel .usage-card { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; padding: 10px; text-align: left; min-width: 0; }
        .usage-card[aria-pressed=true] { border-color: var(--accent); background: var(--bg-selected); }
        .usage-card > strong { font-family: var(--font-mono); font-size: 19px; color: var(--text); white-space: nowrap; }
        .usage-card small { font-size: 12px; }
        .usage-card > span { font-size: 10px; overflow-wrap: anywhere; }
        .usage-card > span:first-child { font-size: 11px; color: var(--text-dim); }
        .usage-summary { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; border-top: 1px solid var(--border); padding: 9px 0; margin: 0 14px; }
        .usage-summary > button { border: 0; padding-left: 0; font-size: 11px; }
        .usage-summary > div { display: flex; flex-wrap: wrap; gap: 5px; min-width: 0; }
        .usage-panel .usage-chip { display: inline-flex; gap: 6px; align-items: center; background: var(--bg-selected); border: 0; font-size: 10px; max-width: 220px; }
        .usage-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .usage-chip strong { font-family: var(--font-mono); }
        .usage-period-total { display: flex; flex-wrap: wrap; gap: 12px; padding: 2px 14px 12px; align-items: baseline; color: var(--text-muted); }
        .usage-period-total strong { font: 600 19px var(--font-mono); color: var(--text); }
        .usage-search { margin: 0 14px 12px; width: calc(100% - 28px); }
        .usage-table-scroll { overflow: auto; max-height: min(440px, 48dvh); padding: 0 14px 8px; }
        .usage-table { border-collapse: collapse; width: 100%; font-size: 11px; white-space: nowrap; }
        .usage-table th, .usage-table td { text-align: right; padding: 9px 8px; border-bottom: 1px solid var(--border); }
        .usage-table thead th { position: sticky; top: 0; background: var(--bg-panel); z-index: 1; color: var(--text-dim); font-weight: 500; }
        .usage-table th:first-child { text-align: left; padding-left: 0; min-width: 124px; max-width: 240px; }
        .usage-table td { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text-muted); }
        .usage-table td strong { color: var(--text); }
        .usage-table tbody th { font-weight: 500; }
        .usage-row-name, .usage-table small { display: block; max-width: 230px; overflow: hidden; text-overflow: ellipsis; }
        .usage-table small { margin-top: 3px; color: var(--text-dim); font-weight: 400; font-size: 9px; }
        .usage-bar { display: block; height: 3px; margin-top: 6px; background: var(--bg-hover); border-radius: 2px; }
        .usage-bar > span { display: block; height: 100%; background: var(--accent); border-radius: inherit; opacity: .65; }
        .usage-footer { padding: 12px 14px; border-top: 1px solid var(--border); font-size: 10px; color: var(--text-dim); line-height: 1.7; overflow-wrap: anywhere; }
        .usage-empty { padding: 24px 14px; text-align: center; color: var(--text-muted); }
        .usage-error, .usage-warning { margin: 0 14px 10px; line-height: 1.6; color: #dc2626; }
        .usage-warning { color: var(--text-muted); }
        @container (max-width: 560px) { .usage-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } .usage-tabs button { padding: 6px 7px; } }
      `}</style>
    </section>
  );
}
