import type { ReactNode } from "react";
import { useGetIdentity } from "@refinedev/core";
import { PageTop } from "../PageTop";
import { HuggingFaceButton } from "../pages/Account";
import { COPY } from "./copy";
import { errorMessage } from "./display";

interface Props {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function HuggingFaceGate({ title, description, actions, children }: Props) {
  const identity = useGetIdentity<{ huggingface_username?: string | null } | null>();
  const signedIn = !identity.isLoading && !identity.error && Boolean(identity.data?.huggingface_username);
  return (
    <>
      <PageTop title={title} description={signedIn ? description : undefined} actions={signedIn ? actions : undefined} />
      {identity.isLoading ? (
        <p className="muted">{COPY.gate.loading}</p>
      ) : identity.error ? (
        <p className="error" role="alert">
          {errorMessage(identity.error)}
        </p>
      ) : !signedIn ? (
        <section className="panel">
          <p className="notice">{COPY.gate.signIn}</p>
          <HuggingFaceButton link />
        </section>
      ) : (
        children
      )}
    </>
  );
}
