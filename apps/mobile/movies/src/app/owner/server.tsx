import type { HealthResponse } from "@media/contracts/media-playback";
import type { Release } from "@media/contracts/release";
import { describeUnreadable } from "@media/mobile-core/failure";
import { readHealth } from "@media/mobile-core/server";
import { TranscodeLabels } from "@media/sdk/effect";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Option } from "effect";
import { router } from "expo-router";
import { Cpu, History, ListChecks, Play, Server } from "lucide-react-native";
import { useEffect, useState } from "react";

import { Loading, OwnerScreen, useNow } from "@/components/owner/parts";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { displayHost } from "@/lib/local-network";
import { capabilityDetail, formatCount } from "@/lib/owner-format";
import { useServer } from "@/session/connection";

const POLL_MS = 10_000;

type Health =
  | { readonly status: "loading" }
  /** The server answers; `report` is none when this app can't read its health report. */
  | {
      readonly status: "up";
      readonly release: Option.Option<Release>;
      readonly report: Option.Option<HealthResponse>;
    }
  | { readonly status: "down" };

const useHealth = (mediaUrl: string): Health => {
  const [health, setHealth] = useState<Health>({ status: "loading" });

  useEffect(() => {
    let live = true;

    const check = async () => {
      const read = await readHealth(mediaUrl);

      if (!live) return;

      setHealth(
        Option.match(read, {
          onNone: (): Health => ({ status: "down" }),
          onSome: ({ release, report }): Health => ({ status: "up", release, report }),
        }),
      );
    };

    void check();
    const timer = setInterval(() => void check(), POLL_MS);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [mediaUrl]);

  return health;
};

const stateOf = (health: Health): string => {
  if (health.status === "down") return "Offline";

  if (health.status === "loading") return "Checking";

  return Option.exists(health.report, ({ backend }) => backend === "connecting")
    ? "Connecting"
    : "Online";
};

/** What the server's health report says, or, when this app can't read it, why. */
function Report({
  release,
  report,
}: {
  readonly release: Option.Option<Release>;
  readonly report: Option.Option<HealthResponse>;
}) {
  if (Option.isNone(report)) {
    return (
      <Text variant="secondary" tone="muted">
        {describeUnreadable(release)}
      </Text>
    );
  }

  return (
    <ListRow icon={Play} title="Active Streams" detail={formatCount(report.value.activeStreams)} />
  );
}

/**
 * The media server's GPUs, one row per render node with the APIs ffmpeg opened it through, and
 * how many transcoding capabilities it verified, found unsupported, and quarantined now, from its
 * last report. The full list is the CLI's.
 */
function Transcoding() {
  const platform = usePlatform();
  const status = usePlatformQuery(platform.core.server.status);
  const now = useNow(60_000);

  if (status.status !== "success" || status.data === null) return null;
  const { transcoding } = status.data;
  const devices = TranscodeLabels.devicesOf(transcoding.devices);

  return (
    <>
      {devices.length === 0 ? <ListRow icon={Cpu} title="CPU Only" /> : null}
      {devices.map((device) => (
        <ListRow
          key={device.node}
          icon={Cpu}
          title={device.label}
          detail={device.apis.length === 0 ? "Not Opened" : device.apis.join(" · ")}
        />
      ))}
      <ListRow
        icon={ListChecks}
        title="Capabilities"
        detail={capabilityDetail(TranscodeLabels.capabilityCounts(transcoding.capabilities, now))}
      />
    </>
  );
}

export default function ServerScreen() {
  const { mediaUrl } = useServer();
  const health = useHealth(mediaUrl);

  return (
    <OwnerScreen title="Server">
      <ListRow icon={Server} title={displayHost(mediaUrl)} detail={stateOf(health)} />
      {health.status === "loading" ? <Loading /> : null}
      {health.status === "up" ? <Report release={health.release} report={health.report} /> : null}
      <Transcoding />
      <ListRow
        icon={History}
        title="Backups"
        detail="Every Night"
        onPress={() => router.push("/owner/backups")}
      />
    </OwnerScreen>
  );
}
