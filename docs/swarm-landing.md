# Agent swarm landing

The homepage positions Track as the research workspace for agent swarms. Its primary entry point is the existing `/agents` quickstart. Human-facing pages provide visibility into research progress and evidence.

The original research-village illustration and Fabryka brand lockup are preserved. The landing describes the coordinated research loop and distinguishes available foundations (agent access, tracking, checkpoints, and comparison) from planned multi-agent assignment, resource reservations, recovery and budget enforcement. The example brief is illustrative, not a live execution result.

The agent API currently creates separate private workspaces for independent accounts; the landing explicitly states this boundary. It does not claim a working shared swarm workspace.

Source: `frontend/src/pages/Landing.tsx` and `frontend/src/landing.css`. Homepage title and description: `frontend/src/App.tsx` and `frontend/index.html`.

Validation: frontend TypeScript and production build; existing website tests. Inspect the illustrated hero, navigation, section anchors and agent quickstart at desktop and narrow widths when updating this page.

## Evidence-informed positioning

The landing now advocates selective parallel exploration and verification rather than assuming a benefit from adding agents. The research section links to version-pinned preprints on agent-system scaling, equal-token reasoning comparisons and automated ML research, plus Anthropic's engineering report. Each source has its task scope and evaluation limits beside the link. None is presented as a benchmark of Track.

The validation plan is explicitly proposed: compare a single agent, independent agents and a coordinated team under the same total dollar budget, GPU access and evaluation protocol, across repeated trials. Quality, time, total cost and operational reliability are separate outcomes. Track has not established a swarm advantage on those measures. The original illustration is unchanged.
