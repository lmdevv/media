import { DownloadsList } from "@/components/downloads/downloads-list";
import { Button } from "@/components/ui/button";
import { HomeLaunchMarks } from "@/lib/app-events";
import { useDownloads } from "@/session/downloads";
import { useOffline } from "@/session/offline";

export default function OfflineDownloads() {
  const offline = useOffline();
  const leave = () => offline?.leave();
  const loaded = useDownloads().snapshot !== null;

  return (
    <>
      <DownloadsList
        chrome="own"
        empty={{ label: "Try Again", onPress: leave }}
        footer={<Button label="Try Again" variant="secondary" onPress={leave} />}
      />
      <HomeLaunchMarks content={loaded ? "downloads" : null} />
    </>
  );
}
