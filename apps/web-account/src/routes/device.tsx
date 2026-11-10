import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";
import { useState } from "react";

import { PageHeader } from "@media/ui/components/page-header";
import { SettingsFrame } from "@/components/shell";
import { describeFailure, isFailure } from "@media/ui/lib/failure";
import { DeviceApprovalView } from "@/screens/entry/device";
import type { Answer } from "@/screens/entry/device";
import { deviceStep } from "@/screens/entry/device-step";
import type { Decision } from "@/screens/entry/device-step";
import { codeLetters, formatUserCode } from "@/screens/entry/user-code";
import { useMe } from "@/session/me";

const DeviceSearch = Schema.Struct({ code: Schema.optionalKey(Schema.String) });

export const Route = createFileRoute("/device")({
  staticData: { need: "account" },
  validateSearch: Schema.toStandardSchemaV1(DeviceSearch),
  head: () => ({ meta: [{ title: "Approve a device · [media]" }] }),
  component: DevicePage,
});

const IDLE: Answer = { kind: "idle" };

function DevicePage() {
  const { code } = Route.useSearch();

  return (
    <SettingsFrame>
      <PageHeader title="Approve a device" />
      <DeviceApproval key={code ?? ""} initial={codeLetters(code ?? "")} />
    </SettingsFrame>
  );
}

function DeviceApproval({ initial }: { readonly initial: string }) {
  const me = useMe();
  const deviceCodes = usePlatform().core.auth.deviceCodes;
  const [letters, setLetters] = useState(initial);
  const [submitted, setSubmitted] = useState(() => formatUserCode(initial));
  const [answer, setAnswer] = useState<Answer>(IDLE);
  const [decision, setDecision] = useState<Decision | null>(null);

  const lookup = usePlatformQuery(
    deviceCodes.lookup,
    ...(submitted === null ? (["skip"] as const) : [{ userCode: submitted }]),
  );

  const step = deviceStep({ letters, submitted, lookup, decision, answer, me });

  const decide = async (kind: Decision["kind"]): Promise<void> => {
    if (step.kind !== "decide") return;

    const { userCode, clientName } = step.device;

    setAnswer({ kind: kind === "approved" ? "approving" : "denying" });

    try {
      await (kind === "approved"
        ? deviceCodes.approve({ userCode, scopes: me.scopes })
        : deviceCodes.deny({ userCode }));
      setDecision({ kind, clientName });
    } catch (cause) {
      setAnswer({
        kind: "failed",
        message: isFailure(cause, "Expired")
          ? "That code has expired. Ask your device for a new one."
          : describeFailure(cause),
      });
    }
  };

  const check = (typed: string): void => {
    const userCode = formatUserCode(codeLetters(typed));

    if (userCode === null) return;

    setAnswer(IDLE);
    setSubmitted(userCode);
  };

  return (
    <DeviceApprovalView
      step={step}
      actions={{
        onLettersChange: (next) => setLetters(codeLetters(next)),
        onSubmitCode: check,
        onApprove: () => void decide("approved"),
        onDeny: () => void decide("denied"),
        onRetry: () => {
          if (lookup.status === "error") lookup.retry();
        },
        onStartOver: () => {
          setLetters("");
          setSubmitted(null);
          setAnswer(IDLE);
          setDecision(null);
        },
      }}
    />
  );
}
