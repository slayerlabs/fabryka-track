# Cockpit positioning

Track's main entry points are the Python SDK, REST API and user-operated agents. The Cockpit at `/overview` leads with private workspace activity for signed-in users and a compact sign-in invitation for confirmed visitors. Session loading, session failure with a retry action, dashboard loading/error, and signed-in empty/data states remain distinct. Counts and recent focused runs precede connection instructions; unknown GPU usage stays unknown rather than appearing as zero.

The connection section has two short choices—Python tracking and an operator-run agent—with contextual links opening `/api-docs#sdk-quickstart`, `/api-docs#agent-existing-workspace` or `/api-docs#agent-independent-account` in a new tab. The public Documentation page owns the browser quickstart and copyable agent instructions. The full SDK/package reference remains in `README.sdk.md`; the manual goal-engine protocol remains in [goal-engine.md](goal-engine.md). `/docs` is live Swagger, not the product guide. The public `/goals` page is Current Lab Goals: RFC proposals and discussion, not an agent setup UI.

The compact resources section retains Checkpoints, Published results, Current Lab Goals, Swagger/OpenAPI and the optional Training sandbox. The sandbox launches real runs only after explicit confirmation. Opening or copying documentation does not create credentials, submit a goal or allocate compute.

`OverviewPage` retains an optional landing layout. Connection instructions are no longer duplicated in the Cockpit; its empty-state Python link targets the same documentation anchor. Independent agent registration at `/agents` never shares the human account's private runs or datasets.
