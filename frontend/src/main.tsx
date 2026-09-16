import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Refine } from "@refinedev/core";
import routerProvider from "@refinedev/react-router";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { authProvider, dataProvider } from "./provider";
import "./styles.css";
import "./public.css";

const legacy = window.location.hash.slice(1);
if (
  /^(new|runs|benchmarks|leaderboard|guide|login|register|account|run\/[a-zA-Z0-9-]+|compare\/[a-zA-Z0-9,-]+)(\?.*)?$/.test(
    legacy,
  )
) {
  window.location.replace("/" + legacy);
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <Refine
          dataProvider={dataProvider}
          authProvider={authProvider}
          routerProvider={routerProvider}
          resources={[
            { name: "goals", list: "/" },
            { name: "runs", list: "/runs", show: "/run/:id", create: "/new" },
            { name: "benchmarks", list: "/benchmarks" },
            { name: "leaderboard", list: "/leaderboard" },
          ]}
          options={{
            disableTelemetry: true,
            reactQuery: {
              clientConfig: {
                defaultOptions: {
                  queries: { retry: false, refetchOnWindowFocus: false },
                },
              },
            },
          }}
        >
          <App />
        </Refine>
      </BrowserRouter>
    </StrictMode>,
  );
}
