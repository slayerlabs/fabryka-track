import type { ReactNode } from "react";
import { useGetIdentity } from "@refinedev/core";
import { PageTop } from "../PageTop";
import { HuggingFaceButton } from "../pages/Account";
import { errorMessage } from "./display";

export function HuggingFaceGate({ description, children }: { description?: string; children: ReactNode }) {
  const identity = useGetIdentity<{ huggingface_username?: string | null } | null>();
  const signedIn = !identity.isLoading && !identity.error && Boolean(identity.data?.huggingface_username);
  return (
    <>
      <PageTop description={signedIn ? description : undefined} />
      {identity.isLoading ? (
        <p className="muted">Loading…</p>
      ) : identity.error ? (
        <p className="error" role="alert">
          {errorMessage(identity.error)}
        </p>
      ) : !signedIn ? (
        <section className="panel">
          <p className="notice">Sign in with Hugging Face to upload data.</p>
          <HuggingFaceButton link />
        </section>
      ) : (
        children
      )}
    </>
  );
}
