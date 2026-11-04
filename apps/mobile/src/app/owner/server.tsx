import type { HealthResponse } from "@media/contracts/media-playback";
import { Option } from "effect";
import { router } from "expo-router";
import { History, Play, Server, Settings2 } from "lucide-react-native";
import { useEffect, useState } from "react";

import { Loading, OwnerScreen } from "@/components/owner/parts";
import { useOwnerViewer } from "@/components/owner/viewer";
import { ListRow } from "@/components/ui/list-row";
import { readHealth } from "@/lib/discovery";
import { displayHost } from "@/lib/local-network";
import { formatCount } from "@/lib/owner-format";
import { useServer } from "@/session/connection";

const POLL_MS = 10_000;

type Health =
  | { readonly status: "loading" }
  | { readonly status: "up"; readonly health: HealthResponse }
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
          onSome: (value): Health => ({ status: "up", health: value }),
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

  return health.health.backend === "connecting" ? "Connecting" : "Online";
};

export default function ServerScreen() {
  const { mediaUrl } = useServer();
  const { scopes } = useOwnerViewer();
  const health = useHealth(mediaUrl);

  return (
    <OwnerScreen title="Server">
      <ListRow icon={Server} title={displayHost(mediaUrl)} detail={stateOf(health)} />
      {health.status === "loading" ? <Loading /> : null}
      {health.status === "up" ? (
        <>
          <ListRow
            icon={Play}
            title="Active Streams"
            detail={formatCount(health.health.activeStreams)}
          />
          <ListRow
            icon={Settings2}
            title="Hardware Acceleration"
            detail={ACCELERATION[health.health.hardwareAcceleration]}
          />
        </>
      ) : null}
      {scopes.includes("admin") ? (
        <ListRow
          icon={History}
          title="Backups"
          detail="Every Night"
          onPress={() => router.push("/owner/backups")}
        />
      ) : null}
    </OwnerScreen>
  );
}
