import { describeFailure, isFailure } from "@/lib/failure";

import type { Answer, CodeProblem, DeviceStep } from "./device";
import type { Lookup } from "./lookup";
import { codeLetters } from "./user-code";

/** What the core says about the device waiting on a code. */
export interface CodeLookup {
  readonly clientName: string;
  readonly state: "pending" | "approved" | "denied" | "redeemed" | "expired";
}

/** The person's answer once the core took it. */
export interface Decision {
  readonly kind: "approved" | "denied";
  readonly clientName: string;
}

/** Everything that decides the step of approving a device. */
export interface DeviceInputs {
  /** The letters in the boxes. */
  readonly letters: string;
  /** The code last submitted, `HDKR-BGTL`, or null before the first. */
  readonly submitted: string | null;
  /** Loading until a code is submitted. */
  readonly lookup: Lookup<CodeLookup>;
  readonly decision: Decision | null;
  readonly answer: Answer;
  readonly me: { readonly username: string; readonly scopes: ReadonlyArray<string> };
}

const USED = { title: "That code was already used.", ending: "is used up" } as const;

/** Why a code in each state can't be approved; a pending one can. */
const ENDED: Record<
  CodeLookup["state"],
  { readonly title: string; readonly ending: string } | null
> = {
  pending: null,
  expired: { title: "That code has expired.", ending: "expired" },
  denied: { title: "That code was denied.", ending: "was denied" },
  approved: USED,
  redeemed: USED,
};

const problemOf = (userCode: string, state: CodeLookup["state"]): CodeProblem | null => {
  const ended = ENDED[state];

  return ended === null
    ? null
    : {
        title: ended.title,
        tone: "warning",
        message: `${userCode} ${ended.ending}. Ask your device for a new code.`,
      };
};

/**
 * The step `inputs` put the page on. A problem with the submitted code shows until the person
 * edits the boxes. While an answer is in flight the device stays on screen, though the core may
 * already report the code approved.
 */
export const deviceStep = (inputs: DeviceInputs): DeviceStep => {
  const { letters, submitted, lookup, decision, answer, me } = inputs;

  if (decision !== null) {
    return decision.kind === "approved"
      ? { kind: "approved", clientName: decision.clientName, username: me.username }
      : { kind: "denied", clientName: decision.clientName };
  }

  if (submitted === null) return { kind: "enter", letters, problem: null };

  const edited = letters !== codeLetters(submitted);

  if (lookup.status === "loading") return { kind: "checking" };

  if (lookup.status === "error") {
    if (!isFailure(lookup.error, "NotFound")) {
      return { kind: "unreachable", message: describeFailure(lookup.error) };
    }

    return {
      kind: "enter",
      letters,
      problem: edited
        ? null
        : {
            title: "That code isn't valid.",
            tone: "danger",
            message: `No device is waiting for ${submitted}.`,
          },
    };
  }

  const busy = answer.kind === "approving" || answer.kind === "denying";
  const problem = busy ? null : problemOf(submitted, lookup.data.state);

  if (problem === null) {
    return {
      kind: "decide",
      device: {
        clientName: lookup.data.clientName,
        userCode: submitted,
        username: me.username,
        scopes: me.scopes,
      },
      answer,
    };
  }

  return { kind: "enter", letters, problem: edited ? null : problem };
};
