# Overview positioning

Track's main entry points are the Python SDK, REST API and user-operated agents. `/overview` introduces these before the browser research workspace and links to account API keys, the SDK README, live API documentation and Goals.

Training runs on the user's machine or compute provider. The web workspace helps inspect metrics, logs, artifacts, checkpoints and recorded evaluations. Training studio remains an optional guided workflow in the footer.

The overview's research cycle is Connect, Track, Coordinate, Review. Goals connects a remote engine to the current workspace; independent agent registration creates a separate account. Keep this distinction explicit.

`OverviewPage` also supplies workflow content to the landing page; shared sections keep the same API/SDK/agent positioning.

The primary framing is collaboration between people and agents through recorded experiments. People set direction and review evidence; agents and scripts report through the API/SDK. The SDK entry is a numbered setup with copyable installation, configuration and integration snippets, using the public `fabryka` package. Do not imply automatic shared access across independently registered agent workspaces.
