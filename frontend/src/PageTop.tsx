import { useEffect, type ReactElement, type ReactNode } from "react";
import { Link, matchPath, useLocation } from "react-router";
import "./page-top.css";

export type Breadcrumb = Readonly<{ label: string; to: string }>;
export type PageTopProps = {
  title?: string;
  ancestors?: readonly Breadcrumb[];
  description?: ReactNode;
  actions?: ReactNode;
};

type PageMeta = { title: string; ancestors: readonly Breadcrumb[] };
const home: Breadcrumb = { label: "Home", to: "/" };
const goals: Breadcrumb = { label: "Goals", to: "/goals" };
const uploads: Breadcrumb = { label: "Data uploads", to: "/uploads" };
const runs: Breadcrumb = { label: "Focused runs", to: "/runs" };
const pages: readonly [string, string][] = [
  ["/overview", "Overview"],
  ["/new", "Training studio"],
  ["/runs", "Focused runs"],
  ["/checkpoints", "Checkpoints"],
  ["/benchmarks", "Evaluation queue"],
  ["/uploads", "Data uploads"],
  ["/leaderboard", "Fabryka leaderboard"],
  ["/models", "Model leaderboard"],
  ["/goals", "Goals"],
  ["/status", "Status"],
  ["/agents", "Agent sign up"],
  ["/benchmark-results", "Published benchmark results"],
  ["/guide", "Training guide"],
  ["/login", "Sign in"],
  ["/account", "Account"],
];

export function resolvePageMeta(pathname: string): PageMeta {
  const matches = (path: string) =>
    matchPath({ path, end: true, caseSensitive: false }, pathname);
  if (matches("/goals/250m-english-base-model"))
    return { title: "Train a 250M English base model", ancestors: [home, goals] };
  const upload = matches("/uploads/:id");
  if (upload)
    return { title: `Upload ${upload.params.id!.slice(0, 8)}`, ancestors: [home, uploads] };
  if (matches("/run/:id"))
    return { title: "Run dashboard", ancestors: [home] };
  if (matches("/compare/:ids"))
    return { title: "Compare runs", ancestors: [home, runs] };

  return { title: pages.find(([path]) => matches(path))?.[1] ?? "Page not found", ancestors: [home] };
}

export function PageTop({ title, ancestors, description, actions }: PageTopProps): ReactElement {
  const { pathname } = useLocation();
  const defaults = resolvePageMeta(pathname);
  const effectiveTitle = title ?? defaults.title;
  const breadcrumbs = ancestors ?? defaults.ancestors;
  useEffect(() => {
    document.title = `${effectiveTitle} · Fabryka Track`;
  }, [effectiveTitle]);

  return (
    <header className="page-top">
      <nav className="page-top-breadcrumbs" aria-label="Breadcrumb">
        <ol>
          {breadcrumbs.map(({ label, to }) => (
            <li key={to}>
              <Link to={to}>{label}</Link>
              <span className="page-top-separator" aria-hidden="true">/</span>
            </li>
          ))}
          <li aria-current="page">{effectiveTitle}</li>
        </ol>
      </nav>
      <div className="page-top-content">
        <div className="page-top-copy">
          <h1>{effectiveTitle}</h1>
          {description && <div className="page-top-description">{description}</div>}
        </div>
        {actions && <div className="page-top-actions">{actions}</div>}
      </div>
    </header>
  );
}
