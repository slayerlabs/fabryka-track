import { Link } from "react-router";
import { Icon } from "../Icons";

function Arrow() {
  return <span aria-hidden="true">→</span>;
}

function TrainingPreview() {
  return (
    <figure
      className="landing-dashboard"
      aria-label="Illustrative training dashboard with a loss curve, dataset mix, and saved checkpoints"
    >
      <figcaption className="landing-dashboard-header">
        <span className="landing-run-title">
          <span className="landing-live-dot" /> glowline-byte-83m
        </span>
        <span>Illustrative example</span>
      </figcaption>
      <div className="landing-chart-panel">
        <div className="landing-chart-heading">
          <span>Training loss</span>
          <span className="landing-training-state">
            <span className="landing-live-dot" /> Training
          </span>
        </div>
        <svg
          className="landing-loss-chart"
          viewBox="0 0 500 175"
          role="img"
          aria-label="Illustrative training loss decreasing from 3.2 to 1.42 over 44,000 steps"
        >
          <g fill="none" stroke="currentColor" className="landing-chart-grid">
            <path d="M36 16V141H480M36 20H480M36 60H480M36 100H480" />
          </g>
          <g className="landing-chart-labels">
            <text x="6" y="24">3.2</text>
            <text x="6" y="64">2.4</text>
            <text x="6" y="104">1.6</text>
            <text x="6" y="144">0.8</text>
            <text x="34" y="160">0</text>
            <text x="215" y="160">20k</text>
            <text x="460" y="160">44k</text>
            <text x="247" y="174">Steps</text>
          </g>
          <path
            className="landing-chart-line"
            d="M36 20 80 36 125 51 170 65 214 77 258 85 303 93 347 98 392 104 436 108 480 110"
            fill="none"
          />
          <path className="landing-chart-guide" d="M480 110v31" />
          <circle className="landing-chart-point" cx="480" cy="110" r="3.5" />
        </svg>
        <p className="landing-mix-label">Dataset mix · 100%</p>
        <div className="landing-mix-bar" aria-label="Web 40%, code 25%, dialogue 20%, docs 15%">
          <span /><span /><span /><span />
        </div>
        <div className="landing-mix-legend">
          <span>Web 40%</span><span>Code 25%</span><span>Dialogue 20%</span><span>Docs 15%</span>
        </div>
      </div>
      <div className="landing-checkpoints">
        <p>Saved checkpoints</p>
        <div><strong>ckpt-44000 <small>loss 1.42</small></strong><span>Evaluated</span></div>
        <div><strong>ckpt-36000 <small>loss 1.58</small></strong><span>Evaluated</span></div>
      </div>
    </figure>
  );
}

export function LandingPage() {
  return (
    <div className="landing-page">
      <header className="landing-header">
        <div className="landing-wrap landing-nav-shell">
          <Link className="landing-brand" to="/" aria-label="Fabryka Track home">
            fabryka<span>.</span> <small>/ track</small>
          </Link>
          <nav className="landing-desktop-nav" aria-label="Primary">
            <a href="#research">Research</a>
            <Link to="/benchmark-results">Published results</Link>
            <a href="#academy">Fabryka Academy</a>
          </nav>
          <details className="landing-mobile-nav">
            <summary>Menu</summary>
            <nav aria-label="Mobile">
              <a href="#research">Research</a>
              <Link to="/benchmark-results">Published results</Link>
              <a href="#academy">Fabryka Academy</a>
            </nav>
          </details>
          <Link className="landing-signin" to="/login">Sign in</Link>
        </div>
      </header>

      <main className="landing-main">
        <section className="landing-hero">
          <div className="landing-wrap">
            <div className="landing-hero-grid">
              <div className="landing-hero-copy">
                <h1>From training idea <span>to evaluated model</span></h1>
                <p className="landing-hero-context">A score is only useful with a context</p>
                <p className="landing-hero-description">
                  Configure datasets, launch training runs, monitor metrics, and compare checkpoints in one workspace.
                </p>
              </div>
              <TrainingPreview />
            </div>
            <div className="landing-actions" aria-label="Choose your next step">
              <Link className="landing-action-card" to="/new">
                <span className="landing-action-icon"><Icon name="flask" /></span>
                <span><strong>Open training studio</strong><small>Choose your data and settings to start a new model experiment.</small></span>
                <Arrow />
              </Link>
              <Link className="landing-action-card" to="/benchmark-results">
                <span className="landing-action-icon"><Icon name="chart" /></span>
                <span><strong>Explore published results</strong><small>Inspect model scores and the run details behind each result.</small></span>
                <Arrow />
              </Link>
            </div>
          </div>
        </section>

        <section className="landing-research" id="research">
          <div className="landing-wrap">
            <div className="landing-research-intro">
              <h2>Research is more than<br />a leaderboard number.</h2>
              <p>The useful questions come after the score: what was tested, how was it evaluated, and what should we try next?</p>
            </div>
            <div className="landing-research-grid">
              <article className="landing-research-card">
                <div className="landing-step-top"><span>01</span><Icon name="target" /></div>
                <h3>Read the goal</h3>
                <p>Start with a question and a clear idea of what the experiment should test.</p>
                <div className="landing-step-visual"><small>Research question</small><strong>“Does a higher dialogue share improve short-form coherence?”</strong></div>
              </article>
              <article className="landing-research-card">
                <div className="landing-step-top"><span>02</span><Icon name="layers" /></div>
                <h3>Inspect the experiment</h3>
                <p>Review the dataset mix, settings, and saved checkpoint before interpreting the result.</p>
                <div className="landing-step-visual">
                  <small>Saved checkpoint</small><strong className="landing-mono">ckpt-44000</strong>
                  <div className="landing-mix-bar" aria-label="Example dataset mix"><span /><span /><span /><span /></div>
                  <div className="landing-mix-legend"><span>Web 40</span><span>Code 25</span><span>Dialogue 20</span><span>Docs 15</span></div>
                </div>
              </article>
              <article className="landing-research-card">
                <div className="landing-step-top"><span>03</span><Icon name="chart" /></div>
                <h3>Interpret the result</h3>
                <p>Compare scores within the same evaluation suite and mode, alongside the setup.</p>
                <div className="landing-step-visual landing-score-visual">
                  <div><span style={{ height: "64%" }}>0.64</span><small>mix A</small></div>
                  <div><span style={{ height: "68%" }}>0.68</span><small>mix B</small></div>
                  <p><span className="landing-live-dot" /> Same suite · Same mode</p>
                </div>
              </article>
            </div>
            <p className="landing-research-caption">Illustrative experiment and scores</p>
          </div>
        </section>

        <section className="landing-academy" id="academy">
          <div className="landing-wrap">
            <div className="landing-section-heading">
              <div>
                <span className="landing-eyebrow">Learn by building</span>
                <h2>Fabryka Academy</h2>
                <p>Understand the choices behind a model. Learn how to prepare data, follow training, and make sense of the results.</p>
              </div>
              <Link className="landing-text-link" to="/guide">Explore the training guide <Arrow /></Link>
            </div>
            <div className="landing-academy-grid">
              {[
                ["layers", "Data & preparation", "Build your first dataset mix", "Learn how source selection and mixing shape the experiment you are about to run.", "Learn about datasets"],
                ["flask", "Training fundamentals", "Understand a training run", "Get familiar with model settings, loss curves, and the checkpoints saved along the way.", "Explore training basics"],
                ["book", "Evaluation & results", "Read beyond the score", "Understand evaluation protocols and what makes two model results worth comparing.", "Learn about evaluation"],
              ].map(([icon, topic, title, copy, link]) => (
                <Link className="landing-academy-card" to="/guide" key={title}>
                  <span className="landing-academy-icon"><Icon name={icon as "layers" | "flask" | "book"} /></span>
                  <span className="landing-topic">{topic}</span>
                  <h3>{title}</h3><p>{copy}</p>
                  <span className="landing-text-link">{link} <Arrow /></span>
                </Link>
              ))}
            </div>
            <p className="landing-academy-footnote">All learning paths start in the training guide.</p>
          </div>
        </section>

        <section className="landing-journey">
          <div className="landing-wrap">
            <div className="landing-journey-panel">
              <div>
                <span className="landing-eyebrow">Your first experiment</span>
                <h2>Start your journey now.</h2>
                <p className="landing-journey-subhead">Create your first model with a guided wizard.</p>
                <p className="landing-journey-description">Take it step by step: choose your data, set up training, and review your experiment before you launch.</p>
                <Link className="landing-journey-button" to="/new">Start the guided wizard <Arrow /></Link>
              </div>
              <div className="landing-wizard" aria-label="Guided setup concept">
                <div className="landing-wizard-title"><strong>Your first model</strong><small>Guided setup</small></div>
                {[
                  ["1", "Choose your data", "Start with a text source and a dataset mix."],
                  ["2", "Set up training", "Choose a model size and training settings."],
                  ["3", "Review and launch", "Check the setup before starting your run."],
                ].map(([number, title, copy], index) => (
                  <div className={`landing-wizard-step${index === 0 ? " is-active" : ""}`} key={number}>
                    <span>{number}</span><div><strong>{title}</strong><small>{copy}</small></div>
                  </div>
                ))}
                <div className="landing-wizard-progress"><span /></div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-wrap">
          <div className="landing-footer-main">
            <Link className="landing-brand" to="/">fabryka<span>.</span> <small>/ track</small></Link>
            <nav aria-label="Footer">
              <Link to="/goals">Research goals</Link><Link to="/benchmark-results">Published results</Link><a href="#academy">Academy</a><a href="/docs">API / SDK</a>
            </nav>
          </div>
          <div className="landing-footer-bottom"><span>© 2026 Fabryka Track.</span><span>Built for small language-model experiments.</span></div>
        </div>
      </footer>
    </div>
  );
}
