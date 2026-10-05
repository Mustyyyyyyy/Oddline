import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../web/styles.css";

type OutcomeName = string;
type EventStatus = "scheduled" | "live" | "finished" | "postponed" | "cancelled" | "canceled" | "abandoned" | "unknown";
type PageName = "home" | "generate" | "history";
type SportFilter = "all" | Fixture["sport"];
type GenerationPeriod = "daily" | "weekend";

interface Selection {
  id: string;
  market: string;
  selection: OutcomeName;
  odds: number;
  bookmaker: string;
  marketBookmaker: string;
  marketProbability: number;
  updatedAt: string;
}

interface Fixture {
  id: string;
  sport: "football" | "basketball";
  homeTeam: string;
  awayTeam: string;
  league: string;
  startsAt: string;
  status: EventStatus;
  selections: Selection[];
}

interface TicketSelection extends Selection {
  fixtureId: string;
  sport: Fixture["sport"];
  homeTeam: string;
  awayTeam: string;
  league: string;
  startsAt: string;
  status: EventStatus;
}

interface Ticket {
  id: number;
  targetOdds: number;
  combinedOdds: string;
  createdAt: string;
  status: "open" | "live" | "finished" | "legacy";
  source: string;
  period: GenerationPeriod;
  selections: TicketSelection[];
}

interface GeneratedSlip {
  picks: Array<{ fixture: Fixture; selection: Selection }>;
  combinedOdds: string;
  targetOdds: number;
  targetReached: boolean;
  method: string;
  period: GenerationPeriod;
  window: { startsAt: string; endsAt: string };
}

interface ApiError {
  error: string;
}

const titleByPage: Record<PageName, string> = {
  home: "Overview",
  generate: "Generate odds",
  history: "Odds history",
};

function formatDate(value: string | Date, options: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat(undefined, options).format(new Date(value));
}

function selectionLabel(selection: OutcomeName): string {
  if (selection === "home") return "Home";
  if (selection === "away") return "Away";
  if (selection === "draw") return "Draw";
  const spread = /^(home|away):(.+)$/.exec(selection);
  if (spread) return `${spread[1] === "home" ? "Home" : "Away"} ${Number(spread[2]) > 0 ? "+" : ""}${spread[2]}`;
  return selection.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function marketLabel(market: string, sport: Fixture["sport"]): string {
  const [type, line] = market.split(":");
  if (type === "h2h" || type === "3way" || type === "2way") {
    return sport === "football" ? "Match result" : "Moneyline";
  }
  if (type === "totals") return `${sport === "football" ? "Total goals" : "Total points"} (${line})`;
  if (type === "spreads") return `${sport === "football" ? "Handicap" : "Point spread"} (${line})`;
  return market;
}

function formatOdds(value: string | number): string {
  return Number(value).toFixed(2);
}

function statusLabel(status: EventStatus | Ticket["status"]): string {
  switch (status) {
    case "live": return "In progress";
    case "finished": return "Finished";
    case "postponed": return "Postponed";
    case "cancelled":
    case "canceled": return "Cancelled";
    case "abandoned": return "Abandoned";
    case "unknown": return "Status unavailable";
    case "legacy": return "Legacy sample";
    default: return "Scheduled";
  }
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const isJson = response.headers.get("content-type")?.includes("application/json") ?? false;
  let data: unknown;
  if (isJson) {
    try {
      data = await response.json();
    } catch {
      throw new Error("The data service returned an invalid response. Please try again.");
    }
  }
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && "error" in data
      ? String((data as ApiError).error)
      : `The data service returned HTTP ${response.status}. Please try again shortly.`;
    throw new Error(message);
  }
  if (data === undefined) throw new Error("The data service returned an unexpected response. Please try again.");
  return data as T;
}

function App(): React.JSX.Element {
  const [page, setPage] = useState<PageName>(() => getPage());
  const [sportFilter, setSportFilter] = useState<SportFilter>("all");
  const [search, setSearch] = useState("");
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loadError, setLoadError] = useState("");
  const [providerWarnings, setProviderWarnings] = useState<string[]>([]);
  const [feedWarning, setFeedWarning] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [feedConnected, setFeedConnected] = useState(false);
  const [loadingFixtures, setLoadingFixtures] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [generatingSlip, setGeneratingSlip] = useState(false);
  const [generationPeriod, setGenerationPeriod] = useState<GenerationPeriod>("daily");
  const [targetOdds, setTargetOdds] = useState("5");
  const [generationError, setGenerationError] = useState("");
  const [generatedSlip, setGeneratedSlip] = useState<GeneratedSlip | null>(null);
  const [saving, setSaving] = useState(false);
  const [generated, setGenerated] = useState<Ticket | null>(null);
  const [notice, setNotice] = useState("");

  const loadFixtures = useCallback(async (force = false) => {
    setLoadingFixtures(true);
    setLoadError("");
    try {
      const result = await api<{ fixtures: Fixture[]; warnings?: string[] }>(`/api/fixtures${force ? "?refresh=1" : ""}`);
      setFixtures(result.fixtures);
      setProviderWarnings(result.warnings ?? []);
      setFeedConnected(true);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load fixtures.");
      setProviderWarnings([]);
      setFixtures([]);
      setFeedConnected(false);
    } finally {
      setLoadingFixtures(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    setHistoryError("");
    try {
      const result = await api<{ tickets: Ticket[]; feedError?: string | null }>("/api/history");
      setTickets(result.tickets);
      setFeedWarning(result.feedError ?? "");
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not load history.");
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    const handleHash = (): void => setPage(getPage());
    window.addEventListener("hashchange", handleHash);
    void loadFixtures();
    void loadHistory();
    return () => window.removeEventListener("hashchange", handleHash);
  }, [loadFixtures, loadHistory]);

  useEffect(() => {
    if (page === "history") void loadHistory();
    if (page === "generate") void loadFixtures();
  }, [page, loadFixtures, loadHistory]);

  useEffect(() => {
    const refresh = window.setInterval(() => {
      if (page === "history") void loadHistory();
      if (page === "home" || page === "generate") void loadFixtures();
    }, 60_000);
    return () => window.clearInterval(refresh);
  }, [page, loadFixtures, loadHistory]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const upcoming = fixtures.filter((fixture) => fixture.status === "scheduled");
  const matchingUpcoming = upcoming.filter((fixture) => {
    const matchesSport = sportFilter === "all" || fixture.sport === sportFilter;
    const haystack = `${fixture.homeTeam} ${fixture.awayTeam} ${fixture.league}`.toLocaleLowerCase();
    return matchesSport && haystack.includes(search.trim().toLocaleLowerCase());
  });
  const finishedMatches = tickets.flatMap((ticket) => ticket.selections)
    .filter((selection) => selection.status === "finished").length;

  const resetGeneratedSlip = (): void => {
    setGeneratedSlip(null);
    setGenerated(null);
    setGenerationError("");
  };

  const generateSelections = async (): Promise<void> => {
    const parsedTarget = Number(targetOdds);
    const maximum = generationPeriod === "daily" ? 50 : 200;
    if (!Number.isFinite(parsedTarget) || parsedTarget <= 1 || parsedTarget > maximum) {
      setGenerationError(`${generationPeriod === "daily" ? "Daily" : "Weekend"} target odds must be from 1 to ${maximum}.`);
      return;
    }
    setGenerationError("");
    setGeneratedSlip(null);
    setGenerated(null);
    setGeneratingSlip(true);
    try {
      const result = await api<GeneratedSlip>("/api/generate-selections", {
        method: "POST",
        body: JSON.stringify({
          targetOdds: parsedTarget,
          sport: sportFilter,
          period: generationPeriod,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        }),
      });
      setGeneratedSlip(result);
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Could not generate selections.");
    } finally {
      setGeneratingSlip(false);
    }
  };

  const saveGeneratedSlip = async (): Promise<void> => {
    if (!generatedSlip) return;
    setSaving(true);
    try {
      const result = await api<Ticket & { message: string; targetReached: boolean }>("/api/generate", {
        method: "POST",
        body: JSON.stringify({
          targetOdds: generatedSlip.targetOdds,
          selections: generatedSlip.picks.map(({ fixture, selection }) => `${fixture.id}|${selection.id}`),
          period: generatedSlip.period,
          sport: sportFilter,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        }),
      });
      setGenerated(result);
      setNotice("Your slip was saved to history.");
      await loadHistory();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save your slip.");
      if (error instanceof Error && /no longer available/.test(error.message)) {
        await loadFixtures(true);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#home" aria-label="Oddline home">
          <span className="brand-mark">O</span><span>oddline<span className="brand-period">.</span></span>
        </a>
        <div className="sidebar-label">WORKSPACE</div>
        <nav className="main-nav" aria-label="Main navigation">
          <a className={`nav-link ${page === "home" ? "active" : ""}`} href="#home"><span className="nav-icon">⌂</span>Overview</a>
          <a className={`nav-link ${page === "generate" ? "active" : ""}`} href="#generate"><span className="nav-icon">＋</span>Generate odds</a>
          <a className={`nav-link ${page === "history" ? "active" : ""}`} href="#history"><span className="nav-icon">↺</span>History <span className="nav-count">{tickets.length}</span></a>
        </nav>
        <div className="sidebar-bottom">
          <div className={`sidebar-live${feedConnected ? " feed-connected" : ""}`}><span className="live-dot" /><span>{feedConnected ? "Odds API connected" : "Feed not connected"}</span></div>
          <div className="sidebar-footnote">Pre-match odds · The Odds API</div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="crumb-slash">/</span><strong>{titleByPage[page]}</strong></div>
          <div className="topbar-right"><span className="date-chip">{formatDate(new Date(), { weekday: "short", month: "short", day: "numeric" }).toUpperCase()}</span><span className={`feed-chip${feedConnected ? " connected" : ""}`}><span className="live-dot" />{feedConnected ? "Feed online" : "Feed offline"}</span></div>
        </header>
        <div className="info-notice provider-notice">
          <span className="notice-icon">i</span>
          <span><strong>Odds feed, not a prediction:</strong> bookmaker prices and market-implied probabilities come from The Odds API. There is no validated independent forecasting model connected. No outcomes are recommended.</span>
        </div>

        {page === "home" && (
          <section className="page active">
            <div className="page-heading">
              <div><div className="eyebrow">SPORTS DATA · PRE-MATCH</div><h1>Your sports desk</h1><p>Upcoming fixtures and bookmaker prices from The Odds API.</p></div>
              <a className="button button-primary" href="#generate"><span>＋</span> Generate odds</a>
            </div>
            <div className="stats-grid">
              <StatCard label="Upcoming fixtures" value={feedConnected ? upcoming.length : "—"} note="With supported pre-match markets" icon="◷" iconClass="icon-green" />
              <StatCard label="Saved slips" value={tickets.length} note="Stored in shared site history" icon="⌁" iconClass="icon-blue" />
              <StatCard label="Finished picks" value={finishedMatches} note="Status reported by provider" icon="✓" iconClass="icon-violet" />
            </div>
            <div className="section-heading">
              <div><div className="eyebrow">THE BOARD</div><h2>Upcoming fixtures</h2></div>
              <button className="button button-secondary" onClick={() => void loadFixtures(true)} disabled={loadingFixtures}>↻ Refresh feed</button>
            </div>
            <FixtureFilters sport={sportFilter} onSportChange={setSportFilter} search={search} onSearchChange={setSearch} />
            {loadError && <div className="feed-stale-notice">{loadError}</div>}
            {providerWarnings.map((warning) => <div className="feed-stale-notice" key={warning}>{warning}</div>)}
            <div className="fixture-grid">
              {loadingFixtures && !fixtures.length ? <div className="loading-card">Loading current fixtures…</div>
                : matchingUpcoming.length ? matchingUpcoming.slice(0, 6).map((fixture) => <FixtureCard key={fixture.id} fixture={fixture} />)
                  : !loadError && <div className="empty-state">No upcoming events with supported odds in the current feed.</div>}
            </div>
            <div className="bottom-callout"><div className="callout-icon">↗</div><div><strong>Market prices, clearly labelled</strong><p>Odds are bookmaker prices, not independent predictions or recommendations.</p></div><a className="text-link" href="#generate">Build a slip <span>→</span></a></div>
          </section>
        )}

        {page === "generate" && (
          <section className="page active">
            <div className="page-heading">
              <div><div className="eyebrow">BUILD YOUR TICKET</div><h1>Generate a slip</h1><p>Choose a sport and target odds. We’ll assemble a combination from current scheduled market prices for you to review.</p></div>
            </div>
            <div className="generate-layout">
              <form className="panel generate-form" onSubmit={(event) => { event.preventDefault(); void generateSelections(); }}>
                <div className="panel-title"><div><h2>Set your criteria</h2><p>Selections spread across available leagues and live markets.</p></div><span className="step-badge">01 / SET UP</span></div>
                <label className="field-label" htmlFor="target-odds">Target combined odds</label>
                <div className="input-wrap">
                  <span className="input-prefix">×</span>
                  <input id="target-odds" type="number" min="1.01" max={generationPeriod === "daily" ? 50 : 200} step="any" value={targetOdds} onChange={(event) => { setTargetOdds(event.target.value); resetGeneratedSlip(); }} required />
                  <span className="input-suffix">DECIMAL ODDS</span>
                </div>
                <div className="quick-targets">
                  {(generationPeriod === "daily" ? [3, 5, 10, 20, 50] : [5, 10, 20, 50, 100, 200]).map((value) => <button type="button" key={value} onClick={() => { setTargetOdds(String(value)); resetGeneratedSlip(); }}>{value.toFixed(2)}</button>)}
                </div>
                <label className="field-label">Sport</label>
                <SportSelector sport={sportFilter} onSportChange={(sport) => { setSportFilter(sport); resetGeneratedSlip(); }} />
                <label className="field-label">Game period</label>
                <PeriodSelector
                  period={generationPeriod}
                  onPeriodChange={(period) => {
                    setGenerationPeriod(period);
                    if (Number(targetOdds) > (period === "daily" ? 50 : 200)) setTargetOdds(period === "daily" ? "50" : "200");
                    resetGeneratedSlip();
                  }}
                />
                <div className="period-hint">{generationPeriod === "daily" ? "Today only · combined odds capped at 50.00" : "Upcoming Friday through Sunday · combined odds capped at 200.00"}</div>
                {generationError && <div className="feed-stale-notice" role="alert">{generationError}</div>}
                {loadError && !feedConnected && <div className="feed-stale-notice">{loadError}</div>}
                {providerWarnings.map((warning) => <div className="feed-stale-notice" key={warning}>{warning}</div>)}
                <div className="strategy-note">One pick per game, balanced across leagues and available markets. Totals and spreads are included where listed; this feed does not provide corners, shots, or fouls. These odds are not predictions.</div>
                <button className="button button-primary button-wide" type="submit" disabled={generatingSlip || loadingFixtures}>
                  {generatingSlip ? "Building from current markets…" : <>Generate selections <span>→</span></>}
                </button>
                <div className="form-footnote"><span className="live-dot" /> Preview prices refresh live; availability is checked before saving</div>
                {generatedSlip && (
                  <GeneratedSlipPreview
                    slip={generatedSlip}
                    saving={saving}
                    saved={Boolean(generated)}
                    onSave={() => void saveGeneratedSlip()}
                  />
                )}
              </form>
              <aside className="panel rules-panel">
                <div className="eyebrow">HOW IT WORKS</div><h2>Built to keep the numbers honest.</h2>
                <ul className="rule-list">
                  <li><span className="rule-check">✓</span><span><strong>Real bookmaker markets</strong><small>Only fixtures and prices returned by the live provider are used.</small></span></li>
                  <li><span className="rule-check">✓</span><span><strong>Target is a guide</strong><small>If available fixtures cannot reach it, the shortfall is shown clearly.</small></span></li>
                  <li><span className="rule-check">✓</span><span><strong>Prices are checked again</strong><small>Outdated or removed markets cannot be saved.</small></span></li>
                </ul>
                <div className="risk-note"><span>!</span><p>Prices and availability change. This slip does not guarantee results or profits.</p></div>
              </aside>
            </div>
            {generated && <GeneratedTicket ticket={generated} />}
          </section>
        )}

        {page === "history" && (
          <section className="page active">
            <div className="page-heading">
              <div><div className="eyebrow">YOUR ACTIVITY</div><h1>Odds history</h1><p>Every combination you generate, with each match’s latest provider-reported status.</p></div>
              <button className="button button-secondary" onClick={() => { void loadHistory(); void loadFixtures(true); }} disabled={loadingHistory}>↻ Refresh</button>
            </div>
            {feedWarning && <div className="feed-stale-notice">{feedWarning}</div>}
            {providerWarnings.map((warning) => <div className="feed-stale-notice" key={warning}>{warning}</div>)}
            {historyError && <div className="feed-stale-notice">{historyError}</div>}
            <div className="history-summary">
              {tickets.length > 0 && <>
                <span className="summary-pill">Tickets<strong>{tickets.length}</strong></span>
                <span className="summary-pill">Matches<strong>{tickets.reduce((count, ticket) => count + ticket.selections.length, 0)}</strong></span>
                <span className="summary-pill">Finished<strong>{finishedMatches}</strong></span>
              </>}
            </div>
            <div className="history-list">
              {loadingHistory && !tickets.length ? <div className="loading-card">Loading your history…</div>
                : historyError && !tickets.length ? <div className="empty-state">History is unavailable right now. Refresh to try again.</div>
                : tickets.length ? tickets.map((ticket) => <TicketCard key={ticket.id} ticket={ticket} />)
                  : <div className="empty-history"><div className="empty-symbol">↺</div><h2>Your history starts here</h2><p>Generate a combination and it will be saved here automatically.</p><a className="button button-primary" href="#generate">Generate odds <span>→</span></a></div>}
            </div>
          </section>
        )}
        <footer className="site-footer"><span>ODDLINE <span className="brand-period">·</span> SPORTS DATA WORKSPACE</span><span>The Odds API · Independent forecasts unavailable</span></footer>
      </main>
      {notice && <div className="toast show" role="status" aria-live="polite">{notice}</div>}
    </div>
  );
}

function StatCard({ label, value, note, icon, iconClass }: { label: string; value: number | string; note: string; icon: string; iconClass: string }): React.JSX.Element {
  const displayValue = typeof value === "number" ? String(value).padStart(2, "0") : value;
  return <article className="stat-card"><div className="stat-top"><span>{label}</span><span className={`stat-icon ${iconClass}`}>{icon}</span></div><div className="stat-value">{displayValue}</div><div className="stat-note">{note}</div></article>;
}

function FixtureFilters({ sport, onSportChange, search, onSearchChange }: {
  sport: SportFilter;
  onSportChange: (sport: SportFilter) => void;
  search: string;
  onSearchChange: (search: string) => void;
}): React.JSX.Element {
  return (
    <div className="board-controls">
      <label className="search-field">
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search teams or competitions"
          aria-label="Search teams or competitions"
        />
      </label>
      <div className="sport-filters" role="group" aria-label="Filter fixtures by sport">
        {(["all", "football", "basketball"] as const).map((option) => (
          <button
            className={`filter-button${sport === option ? " active" : ""}`}
            type="button"
            key={option}
            aria-pressed={sport === option}
            onClick={() => onSportChange(option)}
          >
            {option === "all" ? "All sports" : option === "football" ? "Soccer" : "Basketball"}
          </button>
        ))}
      </div>
    </div>
  );
}

function SportSelector({ sport, onSportChange }: {
  sport: SportFilter;
  onSportChange: (sport: SportFilter) => void;
}): React.JSX.Element {
  return (
    <div className="sport-filters sport-selector" role="group" aria-label="Choose a sport for slip generation">
      {(["all", "football", "basketball"] as const).map((option) => (
        <button
          className={`filter-button${sport === option ? " active" : ""}`}
          type="button"
          key={option}
          aria-pressed={sport === option}
          onClick={() => onSportChange(option)}
        >
          {option === "all" ? "All sports" : option === "football" ? "Soccer" : "Basketball"}
        </button>
      ))}
    </div>
  );
}

function PeriodSelector({ period, onPeriodChange }: {
  period: GenerationPeriod;
  onPeriodChange: (period: GenerationPeriod) => void;
}): React.JSX.Element {
  return (
    <div className="period-options" role="group" aria-label="Choose daily or weekend games">
      {(["daily", "weekend"] as const).map((option) => (
        <button
          className={`period-option${period === option ? " active" : ""}`}
          type="button"
          key={option}
          aria-pressed={period === option}
          onClick={() => onPeriodChange(option)}
        >
          <strong>{option === "daily" ? "Daily" : "Weekend"}</strong>
          <span>{option === "daily" ? "Today · max 50" : "Fri–Sun · max 200"}</span>
        </button>
      ))}
    </div>
  );
}

function GeneratedSlipPreview({ slip, saving, saved, onSave }: {
  slip: GeneratedSlip;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
}): React.JSX.Element {
  const sportLabel = slip.picks.every(({ fixture }) => fixture.sport === "football")
    ? "Soccer"
    : slip.picks.every(({ fixture }) => fixture.sport === "basketball")
      ? "Basketball"
      : "All sports";
  return (
    <section className="generated-preview" aria-live="polite">
      <div className="preview-heading">
        <div><div className="eyebrow">GENERATED FROM LIVE MARKETS</div><h3>{slip.period === "daily" ? "Daily" : "Weekend"} · {sportLabel} · {slip.picks.length} {slip.picks.length === 1 ? "selection" : "selections"}</h3></div>
        <div className="preview-total"><strong>{formatOdds(slip.combinedOdds)}</strong><span>COMBINED ODDS</span></div>
      </div>
      <div className="preview-window">{formatDate(slip.window.startsAt, { month: "short", day: "numeric" })} – {formatDate(new Date(new Date(slip.window.endsAt).getTime() - 1), { month: "short", day: "numeric" })}</div>
      <div className={`target-result${slip.targetReached ? " reached" : ""}`}>
        {slip.targetReached
          ? `Target ${slip.targetOdds.toFixed(2)} reached`
          : `Target ${slip.targetOdds.toFixed(2)} not reached with the available fixtures`}
      </div>
      <div className="preview-picks">
        {slip.picks.map(({ fixture, selection }) => (
          <article className="preview-pick" key={fixture.id}>
            <div className="preview-match">
              <span>{fixture.homeTeam} <span className="versus">vs</span> {fixture.awayTeam}</span>
              <small>{fixture.league} · {formatDate(fixture.startsAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small>
            </div>
            <div className="preview-outcome">{marketLabel(selection.market, fixture.sport)} · {selectionLabel(selection.selection)} <strong>{selection.odds.toFixed(2)}</strong></div>
          </article>
        ))}
      </div>
      <p className="preview-disclaimer">{slip.method}</p>
      <button className="button button-primary button-wide" type="button" onClick={onSave} disabled={saving || saved || slip.picks.length === 0}>
        {saved ? "Saved to history" : saving ? "Checking prices and saving…" : "Save this slip to history"}
      </button>
    </section>
  );
}

function FixtureCard({ fixture }: { fixture: Fixture }): React.JSX.Element {
  return (
    <article className="fixture-card">
      <div className="fixture-meta"><span className="league-label">{fixture.league}</span><span className={`sport-label${fixture.sport === "basketball" ? " basketball" : ""}`}>{fixture.sport}</span></div>
      <div className="fixture-teams">{fixture.homeTeam}<span className="versus">vs</span>{fixture.awayTeam}</div>
      <div className="fixture-bottom">
        <span>{formatDate(fixture.startsAt, { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
        <div className="fixture-markets">
          {fixture.selections.map((selection) => (
            <span className="fixture-market" key={selection.id}>
              <span>{marketLabel(selection.market, fixture.sport)} · {selectionLabel(selection.selection)}</span>
              <strong>{selection.odds.toFixed(2)}</strong>
            </span>
          ))}
        </div>
      </div>
    </article>
  );
}

function TicketCard({ ticket }: { ticket: Ticket }): React.JSX.Element {
  const status = ticket.status === "finished" ? "finished" : ticket.status === "live" ? "live" : ticket.status === "legacy" ? "legacy" : "open";
  return (
    <article className="ticket-card">
      <div className="ticket-head">
        <div><div className="ticket-id">TICKET #{String(ticket.id).padStart(4, "0")} · {ticket.period.toUpperCase()} SLIP</div><div className="ticket-date">Created {formatDate(ticket.createdAt, { dateStyle: "medium", timeStyle: "short" })}</div></div>
        <div className="ticket-head-right"><div className="ticket-odds"><strong>{formatOdds(ticket.combinedOdds)}</strong><span>COMBINED · TARGET {ticket.targetOdds.toFixed(2)}</span></div><span className={`status-badge status-${status}`}>{statusLabel(status)}</span></div>
      </div>
      {ticket.selections.map((selection) => (
        <div className="ticket-match" key={`${ticket.id}-${selection.fixtureId}`}>
          <div><div className="match-teams">{selection.homeTeam} <span className="versus">vs</span> {selection.awayTeam}</div><div className="match-meta">{selection.league} · {formatDate(selection.startsAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div></div>
          <div className="ticket-market">{marketLabel(selection.market, selection.sport)} · {selectionLabel(selection.selection)}<div className="match-meta">{selection.bookmaker}</div></div>
          <div className="ticket-match-odds">{selection.odds.toFixed(2)}</div>
          <div className="ticket-status"><span className={`status-badge status-${selection.status}`}>{statusLabel(selection.status)}</span>{selection.status === "finished" && <span className="result-unavailable">Final score unavailable</span>}</div>
        </div>
      ))}
    </article>
  );
}

function GeneratedTicket({ ticket }: { ticket: Ticket }): React.JSX.Element {
  return (
    <div className="generated-result">
      <div className="result-header"><div><div className="eyebrow">SLIP SAVED · TICKET #{String(ticket.id).padStart(4, "0")}</div><h2>{ticket.selections.length} user-selected outcomes</h2></div><div className="result-total"><strong>{formatOdds(ticket.combinedOdds)}</strong><span>COMBINED ODDS</span></div></div>
      <div className="result-message">Saved in your history. Prices are snapshots, not predictions. <a className="text-link" href="#history">View in history →</a></div>
      <div className="result-selections">{ticket.selections.map((selection) => (
        <div className="selection-row" key={selection.fixtureId}>
          <div><div className="match-name">{selection.homeTeam} <span className="versus">vs</span> {selection.awayTeam}</div><div className="match-detail">{selection.league} · {formatDate(selection.startsAt, { weekday: "short", hour: "numeric", minute: "2-digit" })} · {selection.bookmaker}</div></div>
          <div className="selection-market">{marketLabel(selection.market, selection.sport)} · {selectionLabel(selection.selection)}</div><div className="selection-odds">{selection.odds.toFixed(2)}</div>
        </div>
      ))}</div>
    </div>
  );
}

function getPage(): PageName {
  const value = window.location.hash.slice(1).split("/")[0];
  return value === "generate" || value === "history" ? value : "home";
}

createRoot(document.getElementById("root")!).render(<App />);
