import { Match } from "effect";

import { BlankPage, UnreachableScreen } from "@/screens/states";

import { EndedLink, OpenLink } from "./link-page";
import type { LinkForm, LinkState } from "./link-page";

/** Whose password an open reset link sets. */
export interface ResetLink {
  readonly username: string;
  readonly expiresAt: number;
}

/** The reset page: whose password the link sets, then the new password. */
export function ResetView({
  state,
  form,
}: {
  readonly state: LinkState<ResetLink>;
  readonly form: Omit<LinkForm, "username" | "onUsernameChange">;
}) {
  return Match.value(state).pipe(
    Match.discriminatorsExhaustive("kind")({
      loading: () => <BlankPage />,
      unreachable: ({ retry }) => <UnreachableScreen retry={retry} />,
      ended: () => (
        <EndedLink title="This link no longer works." next="Ask an admin for a new one." />
      ),
      open: ({ link }) => (
        <OpenLink
          heading={link.username}
          facts="password reset link"
          expiresAt={link.expiresAt}
          title="Set a new password."
          fields="newPassword"
          submitLabel="Set password"
          form={{ ...form, username: link.username, onUsernameChange: () => undefined }}
        />
      ),
    }),
  );
}
