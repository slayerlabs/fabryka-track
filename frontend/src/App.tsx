import { useEffect } from "react";
import { Authenticated, useGetIdentity } from "@refinedev/core";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router";
import type { Identity } from "./provider";
import { StudioPage, GuidePage } from "./pages/Studio";
import { LoginPage, AccountPage } from "./pages/Account";
import { RunsPage } from "./pages/Runs";
import { RunDetailPage } from "./pages/RunDetail";
import { ComparePage } from "./pages/Compare";
import {
  GoalsPage,
  StatusPage,
  AgentsPage,
  TrainingGoalPage,
  PublishedBenchmarksPage,
} from "./pages/Public";
import { BenchmarksPage } from "./pages/Benchmarks";
import { LeaderboardPage } from "./pages/Leaderboard";
import { CheckpointsPage } from "./pages/Checkpoints";
import { useDashboard } from "./pages/DashboardData";
import { Icon, type IconName } from "./Icons";

const navigation: { label: string; links: [string, string, IconName][] }[] = [
  {
    label: "Workspace",
    links: [
      ["/new", "Training studio", "flask"],
      ["/runs", "My runs", "play"],
      ["/checkpoints", "Checkpoints", "layers"],
      ["/benchmarks", "Benchmarks", "chart"],
      ["/leaderboard", "Leaderboard", "trophy"],
    ],
  },
  {
    label: "Research & resources",
    links: [
      ["/", "Goals", "target"],
      ["/status", "Status", "chart"],
      ["/agents", "Agent sign up", "users"],
      ["/benchmark-results", "Published results", "chart"],
      ["/guide", "Training guide", "book"],
      ["https://github.com/slayerlabs/rfcs", "RFC repository", "book"],
    ],
  },
];

export function App() {
  const location = useLocation();
  const { data: identity } = useGetIdentity<Identity | null>();
  const dashboard = useDashboard(Boolean(identity));
  const memory = identity ? dashboard.data?.gpu_memory : undefined;
  useEffect(() => {
    const name =
      navigation
        .flatMap((group) => group.links)
        .find(([path]) => path === location.pathname)?.[1] ||
      (location.pathname.startsWith("/run/")
        ? "Run dashboard"
        : location.pathname.startsWith("/compare/")
          ? "Compare runs"
          : location.pathname.startsWith("/goals/")
            ? "250M English base model"
            : "Account");
    document.title = `${name} · Fabryka Track`;
    if (location.hash)
      requestAnimationFrame(() =>
        document
          .getElementById(decodeURIComponent(location.hash.slice(1)))
          ?.scrollIntoView(),
      );
    else window.scrollTo(0, 0);
  }, [location.pathname, location.hash]);
  return (
    <>
      <div className="app-shell">
        <aside className="sidebar">
          <Link className="brand" to="/">
            <span className="brand-mark">f</span>
            <span className="brand-name">
              fabryka<span>/ track</span>
            </span>
          </Link>
          <nav className="sidebar-nav" aria-label="Main">
            {navigation.map((group) => (
              <details
                className="sidebar-group"
                key={group.label}
                open={group.label === "Workspace" ? true : undefined}
              >
                <summary className="sidebar-group-label">{group.label}</summary>
                <div className="sidebar-links">
                  {group.links.map(([path, label, icon]) => (
                    <NavLink key={path} to={path} end={path === "/"}>
                      <Icon name={icon} />
                      <span>{label}</span>
                      {path === "/runs" && identity && dashboard.data && (
                        <span className="sidebar-count">
                          {dashboard.data.runs.length}
                        </span>
                      )}
                    </NavLink>
                  ))}
                </div>
              </details>
            ))}
          </nav>
          <div className="sidebar-spacer" />
          {identity && (
            <div className="gpu-status-card">
              <div className="gpu-status-label">
                <span
                  className={`gpu-live-dot${memory?.active_runs ? " is-live" : ""}`}
                />
                GPU activity
              </div>
              {memory?.used_gb != null &&
              memory.total_gb != null &&
              memory.total_gb > 0 ? (
                <>
                  <div className="gpu-memory-value">
                    <b>{memory.used_gb.toFixed(1)}</b> /{" "}
                    {memory.total_gb.toFixed(1)} GB VRAM
                  </div>
                  <progress
                    className="gpu-status-bar"
                    value={memory.used_gb}
                    max={memory.total_gb}
                    aria-label="GPU memory usage"
                  />
                </>
              ) : (
                <span className="gpu-status-meta">Live VRAM not reported</span>
              )}
              <span className="gpu-status-meta">
                {dashboard.error
                  ? "GPU status unavailable"
                  : memory
                    ? `${memory.active_runs} active GPU run${memory.active_runs === 1 ? "" : "s"}`
                    : "Loading GPU activity…"}
              </span>
            </div>
          )}
          <NavLink
            className="sidebar-account"
            to={identity ? "/account" : "/login"}
          >
            <Icon name="user" />
            {identity?.username || "Sign in"}
          </NavLink>
        </aside>
        <main className="shell-main" id="app">
          <Routes>
            <Route path="/" element={<GoalsPage />} />
            <Route path="/status" element={<StatusPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route
              path="/goals/250m-english-base-model"
              element={<TrainingGoalPage />}
            />
            <Route
              path="/benchmark-results"
              element={<PublishedBenchmarksPage />}
            />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="/guide" element={<GuidePage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/register"
              element={<Navigate to="/login" replace />}
            />
            <Route path="/run/:id" element={<RunDetailPage />} />
            <Route path="/compare/:ids" element={<ComparePage />} />
            <Route
              path="/new"
              element={
                <Authenticated key="studio" fallback={<LoginPage />}>
                  <StudioPage />
                </Authenticated>
              }
            />
            <Route
              path="/runs"
              element={
                <Authenticated key="runs" fallback={<LoginPage />}>
                  <RunsPage />
                </Authenticated>
              }
            />
            <Route
              path="/checkpoints"
              element={
                <Authenticated key="checkpoints" fallback={<LoginPage />}>
                  <CheckpointsPage />
                </Authenticated>
              }
            />
            <Route
              path="/benchmarks"
              element={
                <Authenticated key="benchmarks" fallback={<LoginPage />}>
                  <BenchmarksPage />
                </Authenticated>
              }
            />
            <Route
              path="/account"
              element={
                <Authenticated key="account" fallback={<LoginPage />}>
                  <AccountPage />
                </Authenticated>
              }
            />
            <Route
              path="*"
              element={
                <section className="panel">
                  <h1>Page not found</h1>
                  <Link to="/">Return to goals</Link>
                </section>
              }
            />
          </Routes>
        </main>
      </div>
      <footer className="app-footer">
        <span>Small experiments. Clear results.</span>
        <span>Fabryka Track</span>
      </footer>
    </>
  );
}
