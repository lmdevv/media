import type { HealthResponse } from "@media/contracts/media-playback";
import type { Release } from "@media/contracts/release";
import { describeUnreadable } from "@media/mobile-core/failure";
import { readHealth } from "@media/mobile-core/server";
import { Option } from "effect";
import { router } from "expo-router";
import { History, Play, Server, Settings2 } from "lucide-react-native";
import { useEffect, useState } from "react";

import { Loading, OwnerScreen } from "@/components/owner/parts";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { displayHost } from "@/lib/local-network";
import { formatCount } from "@/lib/owner-format";
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

const ACCELERATION = {
  qsv: "Intel QSV",
  vaapi: "VA-API",
  none: "Software",
} as const satisfies Record<HealthResponse["hardwareAcceleration"], string>;

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
    <>
      <ListRow
        icon={Play}
        title="Active Streams"
        detail={formatCount(report.value.activeStreams)}
      />
      <ListRow
        icon={Settings2}
        title="Hardware Acceleration"
        detail={ACCELERATION[report.value.hardwareAcceleration]}
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
      <ListRow
        icon={History}
        title="Backups"
        detail="Every Night"
        onPress={() => router.push("/owner/backups")}
      />
    </OwnerScreen>
  );
}
