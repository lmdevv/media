import type { DeviceCodeLookup } from "@media/contracts/models/account";
import type { DeviceScope } from "@media/contracts/scopes";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { Airplay, Check, Clock, Lock, UserRound, X } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { Icon } from "@/components/ui/icon";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { formatUserCode } from "@/lib/device-code";
import { describeFailure, isFailure } from "@/lib/failure";

const APPROVED_SCOPES: ReadonlyArray<DeviceScope> = ["read", "play"];

const enterAgain = () => (router.canGoBack() ? router.back() : router.replace("/approve-device"));

const done = () => router.dismissTo("/you");

function Ending(props: {
  readonly icon: typeof Lock;
  readonly title: string;
  readonly description: string;
  readonly action: string;
  readonly onAction: () => void;
}) {
  return (
    <Screen readable header={<NavHeader fallback="/approve-device" />}>
      <CalmState
        placement="top"
        icon={props.icon}
        title={props.title}
        description={props.description}
        actions={<Button label={props.action} onPress={props.onAction} />}
      />
    </Screen>
  );
}

function Decide({
  device,
  onDeciding,
  onDecided,
}: {
  readonly device: DeviceCodeLookup;
  readonly onDeciding: (deciding: boolean) => void;
  readonly onDecided: (decision: "approved" | "denied") => void;
}) {
  const viewer = useCommandQuery("account.viewer", {});
  const approve = useCommand("deviceAuth.approve");
  const deny = useCommand("deviceAuth.deny");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const held = viewer.status === "success" ? viewer.data.scopes : [];
  const scopes = APPROVED_SCOPES.filter((scope) => held.includes(scope));

  const account =
    viewer.status === "success" ? (viewer.data.user.email ?? viewer.data.user.name) : "";

  const decide = async (decision: "approve" | "deny") => {
    setBusy(decision);
    setError(null);
    onDeciding(true);

    try {
      if (decision === "approve") await approve({ userCode: device.userCode, scopes });
      else await deny({ userCode: device.userCode });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onDecided(decision === "approve" ? "approved" : "denied");
    } catch (cause) {
      setError(describeFailure(cause));
      setBusy(null);
      onDeciding(false);
    }
  };

  return (
    <Screen
      readable
      scroll
      header={<NavHeader title="Approve Sign-In" fallback="/approve-device" />}
    >
      <View className="h-12" />
      <View className="items-center gap-4">
        <Icon icon={Airplay} size="tile" />
        <Text variant="title" className="text-center" accessibilityRole="header">
          {device.clientName}
        </Text>
        <Text variant="bodyMedium" tone="muted">{`Code · ${device.userCode}`}</Text>
      </View>
      <View className="h-8" />
      <ListRow icon={UserRound} title="Account" detail={account} />
      {error === null ? null : (
        <Text variant="meta" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      <Button
        label="Approve"
        icon={Check}
        busy={busy === "approve"}
        disabled={busy !== null || scopes.length === 0}
        onPress={() => void decide("approve")}
      />
      <Button
        label="Deny"
        variant="secondary"
        busy={busy === "deny"}
        disabled={busy !== null}
        onPress={() => void decide("deny")}
      />
    </Screen>
  );
}

export default function ApproveSignIn() {
  const params = useLocalSearchParams<{ userCode: string }>();
  const userCode = formatUserCode(params.userCode);
  const lookup = useCommandQuery("deviceAuth.lookup", userCode === null ? "skip" : { userCode });
  const [deciding, setDeciding] = useState<DeviceCodeLookup | null>(null);

  const [decided, setDecided] = useState<{
    readonly decision: "approved" | "denied";
    readonly name: string;
  } | null>(null);

  if (decided?.decision === "approved") {
    return (
      <Ending
        icon={Check}
        title="Device approved"
        description={`${decided.name} is signed in.`}
        action="Done"
        onAction={done}
      />
    );
  }

  if (decided?.decision === "denied") {
    return (
      <Ending
        icon={X}
        title="Sign-in denied"
        description={`${decided.name} can’t sign in with this code.`}
        action="Done"
        onAction={done}
      />
    );
  }

  const decide = (device: DeviceCodeLookup) => (
    <Decide
      device={device}
      onDeciding={(on) => setDeciding(on ? device : null)}
      onDecided={(decision) => setDecided({ decision, name: device.clientName })}
    />
  );

  if (deciding !== null) return decide(deciding);

  const notFound = (
    <Ending
      icon={Lock}
      title="Code not found"
      description="Check the code on your other device."
      action="Enter Code Again"
      onAction={enterAgain}
    />
  );

  if (userCode === null) return notFound;

  if (lookup.status === "loading") {
    return (
      <Screen readable header={<NavHeader title="Approve Sign-In" fallback="/approve-device" />}>
        <ActivityIndicator className="py-6" colorClassName="accent-text-muted" />
      </Screen>
    );
  }

  if (lookup.status === "error") {
    if (isFailure(lookup.error, "NotFound")) return notFound;

    return (
      <Ending
        icon={Lock}
        title="Couldn’t check the code"
        description={describeFailure(lookup.error)}
        action="Try Again"
        onAction={lookup.retry}
      />
    );
  }

  const device = lookup.data;

  if (device.state === "expired") {
    return (
      <Ending
        icon={Clock}
        title="Code expired"
        description="Ask your other device for a new code."
        action="Enter Code Again"
        onAction={enterAgain}
      />
    );
  }

  if (device.state !== "pending") {
    return (
      <Ending
        icon={Lock}
        title="Code already used"
        description="Each code works once. Ask your other device for a new one."
        action="Enter Code Again"
        onAction={enterAgain}
      />
    );
  }

  return decide(device);
}
