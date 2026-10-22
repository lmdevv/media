/**
 * What a command did (F28): the job it started, followed live; a key, invite link, or reset link
 * to keep; a new playlist to open; or a plain done. One switch on the outcome's kind draws it.
 */
import type { JobId, PlaylistId } from "@music/commands/ids";
import { commands, isCommandName } from "@music/commands/registry";
import type { CommandName } from "@music/commands/registry";
import { useRead } from "@music/sdk/react";
import { router } from "expo-router";
import { Check, Copy, Folder, Info, Key, ListMusic, Lock, Music, Share } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { copyText, shareLink } from "@/components/settings/clipboard";
import { Headline } from "@/components/settings/headline";
import { ValueField } from "@/components/settings/value-field";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { Text } from "@/components/ui/text";
import { jobLine } from "@/lib/actions";
import type { ResultRoute } from "@/lib/actions";
import { countOf } from "@/lib/format";
import { inviteLink, resetLink } from "@/lib/links";
import { useConnection } from "@/session/connection";

import { useHeldSecret } from "@/components/settings/secret-slot";

/** The nav title for each kind of outcome. */
const TITLES = {
  job: "Job started",
  key: "Save your key",
  invite: "Share the invite",
  reset: "Password reset link",
  playlist: "Playlist created",
  none: "Done",
} as const satisfies Record<ResultRoute["kind"], string>;

/** Commands whose job is a scan, which Paper titles "Scan started". */
const SCANS: ReadonlySet<CommandName> = new Set(["libraries.scan", "libraries.create"]);

const backToActions = () => router.dismissTo("/settings/actions");

/** Props for `ActionResultScreen`. */
export interface ActionResultScreenProps {
  /** The command name from the route. */
  readonly command: string;
  /** The outcome from the route; null when the parameters describe none. */
  readonly route: ResultRoute | null;
}

/** The result page for a command that just ran. */
export function ActionResultScreen({ command, route }: ActionResultScreenProps) {
  const name = isCommandName(command) ? command : null;

  if (route === null || name === null) {
    return (
      <Page title="Result" bottom="plain">
        <EmptyState
          icon={Info}
          title="Nothing to show."
          body="Run the action again if you need its result."
          primary={<Button label="Back to Actions" onPress={backToActions} />}
        />
      </Page>
    );
  }

  const title = route.kind === "job" && SCANS.has(name) ? "Scan started" : TITLES[route.kind];

  return (
    <Page
      title={title}
      bottom="plain"
      trailing={<IconButton icon={Check} label="Done" onPress={backToActions} />}
    >
      <Outcome name={name} route={route} />
    </Page>
  );
}

function Outcome({ name, route }: { readonly name: CommandName; readonly route: ResultRoute }) {
  const secret = useHeldSecret();

  switch (route.kind) {
    case "job":
      return <JobOutcome jobId={route.jobId} />;
    case "key":
      return <KeyOutcome secret={secret} />;
    case "invite":
      return <LinkOutcome kind="invite" secret={secret} />;
    case "reset":
      return <LinkOutcome kind="reset" secret={secret} />;
    case "playlist":
      return <PlaylistOutcome playlistId={route.playlistId} />;
    case "none":
      return <DoneOutcome summary={commands[name].summary} />;

    default:
      return null;
  }
}

/** Paper's result hero (F28): a 64pt accent check over a 34/40 headline. */
function ResultHero({ headline }: { readonly headline: string }) {
  return (
    <View className="gap-2 pt-12 pb-6">
      <Icon icon={Check} tone="accent" size="state" />
      <Text variant="hero" accessibilityRole="header">
        {headline}
      </Text>
    </View>
  );
}

const openJob = (jobId: JobId) =>
  router.push({ pathname: "/settings/admin/jobs/[id]", params: { id: jobId } });

function JobOutcome({ jobId }: { readonly jobId: JobId }) {
  const job = useRead("jobs.get", { jobId });
  const libraries = useRead("libraries.list", {});
  const library = libraries?.find((each) => each.id === job?.libraryId);

  return (
    <>
      <ResultHero headline="On its way." />
      <Row
        title={library?.name ?? job?.label ?? "Job"}
        subtitle={job === undefined ? "Loading…" : jobLine(job)}
        leading={{ kind: "icon", icon: Folder, tone: "muted" }}
        trailing={<RowChevron />}
        onPress={() => openJob(jobId)}
      />
      <Notice
        icon={Music}
        title="You can keep listening"
        body="The scan continues on your server. Follow its progress in Jobs."
      />
      <View className="pt-6">
        <Button label="View job" onPress={() => openJob(jobId)} />
      </View>
    </>
  );
}

/** A copy button that says Copied once the clipboard has the text. */
function CopyButton({
  label,
  text,
  variant,
}: {
  readonly label: string;
  readonly text: string;
  readonly variant: "primary" | "secondary";
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await copyText(text);
    setCopied(true);
  };

  return (
    <Button
      label={copied ? "Copied" : label}
      icon={Copy}
      variant={variant}
      onPress={() => void copy()}
    />
  );
}

/** A new API key, shown once; null once it has been. */
function KeyOutcome({ secret: key }: { readonly secret: string | null }) {
  if (key === null) {
    return (
      <EmptyState
        icon={Key}
        title="The key was shown once."
        body="If you didn't save it, revoke it and create another in API keys."
        primary={<Button label="Open API keys" onPress={() => router.push("/settings/keys")} />}
      />
    );
  }

  return (
    <>
      <Headline top="regular">{"Copy it\nbefore you go."}</Headline>
      <View className="pt-4">
        <Notice
          icon={Key}
          title="Shown only once"
          body="Copy this key now. After you leave this screen, you can’t reveal it again."
        />
      </View>
      <ValueField label="API key" value={key} wrap />
      <View className="pt-6">
        <CopyButton label="Copy API key" text={key} variant="primary" />
      </View>
    </>
  );
}

/** How an invite or reset link is presented (F11, F23). */
const LINKS = {
  invite: {
    build: inviteLink,
    headline: "Their next favorite\nsong is here.",
    label: "One-time invite link",
    helper: "Works once · Expires in 7 days.",
    share: "Share invite",
  },
  reset: {
    build: resetLink,
    headline: "A way back in.",
    label: "One-time reset link",
    helper: "Works once · Expires in 24 hours.",
    share: "Share link",
  },
} as const;

function LinkOutcome({
  kind,
  secret,
}: {
  readonly kind: keyof typeof LINKS;
  readonly secret: string | null;
}) {
  const { origin } = useConnection();
  const copy = LINKS[kind];

  if (secret === null) {
    return (
      <EmptyState
        icon={Lock}
        title="The link was shown once."
        body="Run the action again for a new link."
        primary={<Button label="Back to Actions" onPress={backToActions} />}
      />
    );
  }

  const link = copy.build(origin, secret);

  return (
    <>
      <Headline top="loose">{copy.headline}</Headline>
      <ValueField label={copy.label} value={link} helper={copy.helper} />
      {kind === "reset" ? (
        <View className="pt-4">
          <Notice
            icon={Lock}
            title="Share privately"
            body="Anyone with this link can set a new password. It works once."
          />
        </View>
      ) : null}
      <View className="pt-6">
        <Button
          label={copy.share}
          icon={Share}
          onPress={() => void shareLink(link).catch(() => undefined)}
        />
      </View>
      <View className="pt-3">
        <CopyButton label="Copy link" text={link} variant="secondary" />
      </View>
    </>
  );
}

function PlaylistOutcome({ playlistId }: { readonly playlistId: PlaylistId }) {
  const playlist = useRead("playlists.get", { playlistId });

  return (
    <>
      <ResultHero headline="It’s ready." />
      {playlist === undefined ? null : (
        <Row
          title={playlist.playlist.name}
          subtitle={countOf(playlist.playlist.trackCount, "song")}
          leading={{ kind: "icon", icon: ListMusic, tone: "muted" }}
        />
      )}
      <View className="pt-6">
        <Button
          label="Open playlist"
          onPress={() =>
            router.navigate({ pathname: "/playlist/[id]", params: { id: playlistId } })
          }
        />
      </View>
    </>
  );
}

function DoneOutcome({ summary }: { readonly summary: string }) {
  return (
    <>
      <ResultHero headline="Done." />
      <Text tone="muted">{summary}</Text>
      <View className="pt-6">
        <Button label="Back to Actions" variant="secondary" onPress={backToActions} />
      </View>
    </>
  );
}
