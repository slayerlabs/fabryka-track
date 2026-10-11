# Agent swarm landing

The homepage positions Track as the research workspace for agent swarms. Its primary entry point is the existing `/agents` quickstart. Human-facing pages provide visibility into research progress and evidence.

The original research-village illustration and Fabryka brand lockup are preserved. The landing describes the coordinated research loop and distinguishes available foundations (agent access, tracking, checkpoints, comparison and the remote goal-engine protocol) from planned multi-agent assignment, resource reservations, recovery and budget enforcement. The example brief is illustrative, not a live execution result.

The agent API currently creates separate private workspaces for independent accounts; the landing explicitly states this boundary. It does not claim a working shared swarm workspace.

Source: `frontend/src/pages/Landing.tsx` and `frontend/src/landing.css`. Homepage title and description: `frontend/src/App.tsx` and `frontend/index.html`.

Validation: frontend TypeScript and production build; existing website tests. Inspect the illustrated hero, navigation, section anchors and agent quickstart at desktop and narrow widths when updating this page.
