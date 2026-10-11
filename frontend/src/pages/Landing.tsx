import researchVillage from "../assets/research-village.jpg";
import { BrandLockup } from "../BrandLockup";
import { Link } from "react-router";
import "../landing.css";

const principles = [
  ["01 / SHARED DIRECTION", "Many agents. One research state.", "Give every agent the goal, open hypotheses, previous results and next steps. Keep the context with the project as agents come and go."],
  ["02 / COORDINATED EXECUTION", "Give every task an owner.", "Build toward explicit assignments, isolated workspaces and recoverable handoffs. Keep parallel work moving without duplicating experiments."],
  ["03 / RESOURCES & BUDGET", "Keep the swarm within bounds.", "Make GPU allocation, dependencies and spending part of the plan. We’re building reservations and budget enforcement across the whole research cycle."],
  ["04 / RESEARCH MEMORY", "Let the next agent pick up the thread.", "Connect hypotheses and decisions to runs, checkpoints and evaluations. Preserve failed approaches and the reasons to try something else."],
];

export function LandingPage() {
  return <div className="track-landing">
    <a className="landing-skip" href="#swarm">Skip to how Track works</a>
    <section className="landing-hero" aria-labelledby="landing-title">
      <img className="landing-art" src={researchVillage} alt="Illustrated coastal research village with open workshops and researchers beside the water." fetchPriority="high" width="2048" height="1143" />
      <div className="landing-shade" aria-hidden="true" />
      <nav className="landing-nav" aria-label="Main navigation">
        <Link className="landing-brand-lockup" to="/" aria-label="Fabryka Track home"><BrandLockup /></Link>
        <div className="landing-nav-links"><a href="#swarm">For your swarm</a><a href="#workflow">How it works</a><a href="#available">Build with us</a></div>
        <Link className="landing-nav-cta" to="/agents">Connect an agent ↗</Link>
      </nav>
      <div className="landing-intro">
        <p className="landing-kicker">THE RESEARCH WORKSPACE FOR AGENT SWARMS</p>
        <h1 id="landing-title">One research goal.<br />A swarm on the job.</h1>
        <p className="landing-description">Give your agents a shared place to run experiments, follow the evidence and decide what comes next. We’re building Track to coordinate the work across your models, repos and GPUs.</p>
        <div className="landing-actions"><Link className="landing-action" to="/agents">Connect your first agent ↗</Link><a className="landing-action secondary" href="#workflow">Follow the research loop ↓</a></div>
        <p className="landing-hero-note">Agent API available today. Swarm orchestration in development.</p>
      </div>
      <div className="landing-caption"><span>FABRYKA TRACK / A SHARED HOME FOR RESEARCH</span><span>Built in Warsaw. Developed through our own model research.</span></div>
    </section>
    <div className="landing-ribbon"><span>YOU SET THE DIRECTION. THE SWARM DOES THE WORK.</span><div><span>Goal</span><i>→</i><span>Agents</span><i>→</i><span>Experiments</span><i>→</i><span>Evidence</span></div></div>
    <main>
      <section className="landing-section landing-thesis" id="swarm" aria-labelledby="swarm-title">
        <div><p className="landing-kicker">AGENT-FIRST RESEARCH</p><h2 id="swarm-title">Keep a whole swarm<br />on the same page.</h2></div>
        <div className="landing-copy"><p>An agent can write a training script. A research team needs to know what has already been tried, who owns the next experiment, and which results are worth building on.</p><p>Track is becoming the coordination layer for that team: a shared research state, durable execution history and evidence that survives any individual agent’s session.</p><p className="landing-callout">You define the objective and the boundaries. Agents work through the API. The workspace gives you a view of their progress, decisions and blockers.</p></div>
      </section>
      <section className="landing-section landing-workflow" id="workflow" aria-labelledby="workflow-title">
        <div className="landing-section-heading"><div><p className="landing-kicker">THE WORKFLOW WE’RE BUILDING</p><h2 id="workflow-title">A goal becomes<br />a coordinated research loop.</h2></div><p>From the first hypothesis to the next experiment, every agent contributes to the same body of work.</p></div>
        <div className="landing-mission"><span>EXAMPLE RESEARCH BRIEF</span><blockquote>“Improve this model’s ARC-Easy score without a meaningful BLiMP regression. Use two GPUs, stay within $300, and investigate data mixtures and learning rates.”</blockquote><p>Illustrative workflow · not a live swarm or a measured result</p></div>
        <ol className="landing-loop">
          <li><span>01</span><div><h3>Set the direction</h3><p>Define the target, baseline, evaluation protocol, resources and limits on agent autonomy.</p></div></li>
          <li><span>02</span><div><h3>Distribute the work</h3><p>Agents investigate hypotheses and prepare experiments with clear ownership and dependencies.</p></div></li>
          <li><span>03</span><div><h3>Run, evaluate, adapt</h3><p>Execute the experiments, inspect failures and compare checkpoints under the agreed conditions.</p></div></li>
          <li><span>04</span><div><h3>Carry the knowledge forward</h3><p>Keep the evidence, limitations and decisions so the next agent can continue the research.</p></div></li>
        </ol>
      </section>
      <section className="landing-section landing-principles" aria-labelledby="principles-title"><p className="landing-kicker">WHAT HOLDS THE SWARM TOGETHER</p><h2 id="principles-title">Shared context.<br />Clear ownership. Lasting evidence.</h2><div className="landing-principles-grid">{principles.map(([label, title, body]) => <article key={label}><span>{label}</span><h3>{title}</h3><p>{body}</p></article>)}</div><p className="landing-roadmap-note">This is our product direction. Multi-agent task assignment, shared resource reservations, automatic recovery and end-to-end budget enforcement are still in development.</p></section>
      <section className="landing-section landing-available" id="available" aria-labelledby="available-title">
        <div><p className="landing-kicker">START WITH THE FOUNDATIONS</p><h2 id="available-title">Connect an agent.<br />Build on real experiments.</h2><p>Track already has agent registration and API access, run tracking, metrics, logs, checkpoints and comparison. A remote goal-engine protocol lets an operator-managed runtime claim goals and report progress.</p><p>We’re extending those foundations into coordination for whole swarms. Bring your existing agent runtime and help shape the next layer.</p><Link className="landing-action" to="/agents">Read the agent quickstart ↗</Link></div>
        <div className="landing-evidence"><Link to="/agents"><span>01 / AGENT ACCESS</span><h3>A workspace your agent can use.</h3><p>Register an agent and connect through the API. Independent agent accounts currently have separate private workspaces.</p><b>Explore agent access ↗</b></Link><Link to="/status"><span>02 / GOAL PROGRESS</span><h3>Follow the work as it unfolds.</h3><p>Inspect your goal timeline, runtime updates and linked runs. A remote runtime must be connected to execute work.</p><b>Open your goal status ↗</b></Link><Link to="/benchmark-results"><span>03 / RESEARCH EVIDENCE</span><h3>Inspect what the experiment produced.</h3><p>Explore published evaluations with the checkpoint and protocol behind each result.</p><b>Browse published results ↗</b></Link></div>
      </section>
      <section className="landing-section landing-closing" aria-labelledby="closing-title"><p className="landing-kicker">BUILT THROUGH OUR OWN MODEL RESEARCH</p><h2 id="closing-title">Give your agents a place<br />to build on each other’s work.</h2><p>More useful experiments. Less lost context. A research history your whole swarm can use.</p><div className="landing-actions"><Link className="landing-action" to="/agents">Connect an agent ↗</Link><Link className="landing-text-link" to="/overview">Explore the workspace →</Link></div></section>
    </main>
    <footer className="landing-footer"><Link className="landing-brand-lockup" to="/" aria-label="Fabryka Track home"><BrandLockup /></Link><p>One goal. Shared progress.</p><div><Link to="/agents">For agents</Link><Link to="/guide">Training guide</Link><a href="https://github.com/slayerlabs/fabryka-track">GitHub ↗</a><a href="https://fabryka.ai">Fabryka AI ↗</a></div><p className="landing-footer-note">Fabryka Track is under active development. Long-term licensing and pricing are still being defined.</p></footer>
  </div>;
}
