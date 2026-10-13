# Training sandbox entry paths

Training Studio is the sidebar group containing Cockpit (`/overview`) and Sandbox (`/new`). Sandbox is titled Training sandbox in the page. Its indented Sandbox leaderboard link opens the public `/leaderboard`. Beginner and Advanced are selected in the page, not in the sidebar. The separate `/models` leaderboard remains under Research & resources. The sandbox label does not imply simulation: the existing launcher starts real runs only after explicit confirmation.

`/new` opens in Beginner mode unless it is a checkpoint fork, which defaults to Advanced. An explicit valid mode takes precedence. Advanced exposes the Ivme recipe, Hugging Face imports, training hyperparameters and scale calculator. Switching paths updates only the `mode` query parameter, retains fork identifiers and other query parameters, preserves the draft and wizard stage, and never launches a run. Browser Back and Forward restore the selected mode.

Agent connection is not a training sandbox step. Cockpit (`/overview`) links to public Documentation (`/api-docs`) for manual setup in the existing workspace or an independent agent account at `/agents`; the full copyable instructions live in Documentation. The public `/goals` page lists RFC proposals, not agent setup. Reading or copying documentation does not launch training or allocate compute. Goal-engine credentials only authorize that protocol; independent registration does not grant access to the human account.

The dataset recipe is an unboxed section inside the workspace panel, with one divider rather than nested rounded cards. Entry cards stack on small screens.
