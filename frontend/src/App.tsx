import { useEffect, useRef, useState } from "react";
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
import { PublicRunsPage } from "./pages/PublicRuns";
import { RunDetailPage } from "./pages/RunDetail";
import { ComparePage } from "./pages/Compare";
import {
  GoalsPage,
  AgentsPage,
  TrainingGoalPage,
  PublishedBenchmarksPage,
} from "./pages/Public";
import { BenchmarksPage } from "./pages/Benchmarks";
import { UploadDetailPage, UploadsPage } from "./pages/Uploads";
import { LeaderboardPage } from "./pages/Leaderboard";
import { ModelBoardPage } from "./pages/ModelBoard";
import { CheckpointsPage } from "./pages/Checkpoints";
import { useDashboard } from "./pages/DashboardData";
import { Icon, type IconName } from "./Icons";
import { OverviewPage } from "./pages/Overview";
import { BrandLockup } from "./BrandLockup";
import { PageTop } from "./PageTop";
import { LandingPage } from "./pages/Landing";

const navigation: { label: string; links: [string, string, IconName][] }[] = [
  {
    label: "Workspace",
    links: [
      ["/overview", "Overview", "layers"],
      ["/agents", "Connect an agent", "users"],
      ["/new", "Training studio", "flask"],
      ["/runs", "Focused runs", "play"],
      ["/checkpoints", "Checkpoints", "layers"],
      ["/benchmarks", "Evaluation queue", "chart"],
      ["/leaderboard", "Fabryka leaderboard", "trophy"],
    ],
  },
  {
    label: "Research & resources",
    links: [
      ["/goals", "Goals", "target"],
      ["/benchmark-results", "Published results", "chart"],
      ["/public-runs", "Public runs", "play"],
      ["/leaderboard", "Training results", "trophy"],
      ["/models", "Model leaderboard", "trophy"],
      ["/guide", "Training guide", "book"],
    ],
  },
];

export function App() {
  const location = useLocation();
  useEffect(() => {
    if (location.pathname === "/")
      document.title = "Research workspace for agent swarms · Fabryka Track";
    if (location.hash)
      requestAnimationFrame(() =>
        document
          .getElementById(decodeURIComponent(location.hash.slice(1)))
          ?.scrollIntoView(),
      );
    else window.scrollTo(0, 0);
  }, [location.pathname, location.hash]);
  if (location.pathname === "/") return <LandingPage />;
  return <ApplicationShell />;
}

function ApplicationShell() {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const { data: identity } = useGetIdentity<Identity | null>();
  const dashboard = useDashboard(Boolean(identity));
  const memory = identity ? dashboard.data?.gpu_memory : undefined;
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    closeButton.current?.focus();
    const mobile = window.matchMedia("(max-width: 760px)");
    const closeOnDesktop = () => {
      if (!mobile.matches) setMenuOpen(false);
    };
    mobile.addEventListener("change", closeOnDesktop);
    return () => mobile.removeEventListener("change", closeOnDesktop);
  }, [menuOpen]);
  function dismissMenu() {
    setMenuOpen(false);
    requestAnimationFrame(() => menuButton.current?.focus());
  }
  function handleMenuKeys(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      dismissMenu();
    } else if (event.key === "Tab") {
      const focusable = panel.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }
  return (
    <>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-header" inert={menuOpen}>
            <Link className="brand" to="/" aria-label="Fabryka Track home">
              <BrandLockup />
            </Link>
            <button
              ref={menuButton}
              className="sidebar-menu-toggle"
              type="button"
              aria-label="Open menu"
              aria-expanded={menuOpen}
              aria-controls="sidebar-menu"
              onClick={() => setMenuOpen(true)}
            >
              <span aria-hidden="true">☰</span>
            </button>
          </div>
          <div
            ref={panel}
            id="sidebar-menu"
            className={`sidebar-panel${menuOpen ? " is-open" : ""}`}
            onKeyDown={menuOpen ? handleMenuKeys : undefined}
            role={menuOpen ? "dialog" : undefined}
            aria-modal={menuOpen ? true : undefined}
            aria-label={menuOpen ? "Main menu" : undefined}
          >
            <div className="sidebar-panel-header">
              <Link className="brand" to="/" aria-label="Fabryka Track home" onClick={() => setMenuOpen(false)}>
                <BrandLockup />
              </Link>
              <button
                ref={closeButton}
                className="sidebar-menu-close"
                type="button"
                aria-label="Close menu"
                onClick={dismissMenu}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <nav className="sidebar-nav" aria-label="Main">
              {navigation.map((group) => (
                <section className="sidebar-group" key={group.label} aria-label={group.label}>
                  <h2 className="sidebar-group-label">{group.label}</h2>
                  <div className="sidebar-links">
                    {group.links.map(([path, label, icon]) => (
                      <NavLink key={path} to={path} end={path === "/"} onClick={() => setMenuOpen(false)}>
                        <Icon name={icon} />
                        <span>{label}</span>
                        {path === "/runs" && identity && dashboard.data && (
                          <span className="sidebar-count">
                            {
                              dashboard.data.runs.filter((run) => run.focused)
                                .length
                            }
                          </span>
                        )}
                      </NavLink>
                    ))}
                  </div>
                </section>
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
              onClick={() => setMenuOpen(false)}
            >
              <Icon name="user" />
              {identity?.username || "Sign in"}
            </NavLink>
          </div>
        </aside>
        <main className="shell-main" id="app" inert={menuOpen}>
          <Routes>
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="/goals" element={<GoalsPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route
              path="/goals/250m-english-base-model"
              element={<TrainingGoalPage />}
            />
            <Route
              path="/benchmark-results"
              element={<PublishedBenchmarksPage />}
            />
            <Route path="/public-runs" element={<PublicRunsPage />} />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="/models" element={<ModelBoardPage />} />
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
              path="/uploads"
              element={
                <Authenticated key="uploads" fallback={<LoginPage />}>
                  <UploadsPage />
                </Authenticated>
              }
            />
            <Route
              path="/uploads/:id"
              element={
                <Authenticated key="upload" fallback={<LoginPage />}>
                  <UploadDetailPage />
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
                <>
                  <PageTop />
                  <section className="panel">
                    <Link to="/goals">Return to goals</Link>
                  </section>
                </>
              }
            />
          </Routes>
        </main>
      </div>
      <footer className="app-footer" inert={menuOpen}>
        <span>Small experiments. Clear results.</span>
        <span>Fabryka Track</span>
      </footer>
    </>
  );
}
