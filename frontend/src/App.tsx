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

const navigation = [
  {
    label: "Explore",
    links: [
      ["/", "Goals"],
      ["/status", "Status"],
      ["/agents", "Agent sign up"],
      ["https://github.com/slayerlabs/rfcs", "RFC repository"],
    ],
  },
  {
    label: "Build",
    links: [
      ["/new", "Training studio"],
      ["/runs", "My runs"],
    ],
  },
  {
    label: "Compare",
    links: [
      ["/benchmarks", "Benchmarks"],
      ["/benchmark-results", "Published results"],
      ["/leaderboard", "Leaderboard"],
      ["/guide", "Training guide"],
    ],
  },
];

export function App() {
  const location = useLocation();
  const { data: identity } = useGetIdentity<Identity | null>();
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
            Fabryka<span className="brand-sep">/</span>Track
          </Link>
          <nav className="sidebar-nav" aria-label="Main">
            {navigation.map((group) => (
              <div className="sidebar-group" key={group.label}>
                <span className="sidebar-group-label">{group.label}</span>
                {group.links.map(([path, label]) => (
                  <NavLink key={path} to={path} end={path === "/"}>
                    {label}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-spacer" />
          <NavLink to={identity ? "/account" : "/login"}>
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
      <footer>
        <span>Small experiments. Clear results.</span>
        <span>Fabryka Track</span>
      </footer>
    </>
  );
}
