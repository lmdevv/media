import { Match } from "effect";

import { BlankPage, UnreachableScreen } from "@/screens/states";

import { EndedLink, OpenLink } from "./link-page";
import type { LinkForm, LinkState } from "./link-page";

/** What an open invite offers. */
export interface Invite {
  readonly invitedBy: string;
  readonly role: "admin" | "member";
  readonly expiresAt: number;
}

/** The invite page: who invited and as what, then a username and password to join with. */
export function InviteView({
  state,
  form,
}: {
  readonly state: LinkState<Invite>;
  readonly form: LinkForm;
}) {
  return Match.value(state).pipe(
    Match.discriminatorsExhaustive("kind")({
      loading: () => <BlankPage />,
      unreachable: ({ retry }) => <UnreachableScreen retry={retry} />,
      ended: () => (
        <EndedLink title="This invite no longer works." next="Ask whoever sent it for a new one." />
      ),
      open: ({ link }) => (
        <OpenLink
          heading={`${link.invitedBy} invited you`}
          facts={`joins as ${link.role}`}
          expiresAt={link.expiresAt}
          title="You're invited."
          fields="newAccount"
          submitLabel="Create account"
          form={form}
        />
      ),
    }),
  );
}
