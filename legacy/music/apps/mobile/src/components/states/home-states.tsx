/**
 * Home's states around its rails: static placeholders until the first answer (Library's totals
 * use one too), the scan notice and placeholders while a library is being read (G02), and the
 * empty collection (G01), which offers admins a folder to add and tells everyone else what they
 * are waiting on.
 */
import { can } from "@music/commands/permissions";
import { useRead } from "@music/sdk/react";
import { router } from "expo-router";
import { Folder, Music, RotateCw } from "lucide-react-native";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { SectionHeader } from "@/components/ui/section-header";
import { countOf } from "@/lib/format";

/** Whether any library this account hears is being scanned, or undefined while that loads. */
const useScanning = (): boolean | undefined =>
  useRead("libraries.list", {})?.some((library) => library.scanning);

/** A static surface where content will be; Paper draws no shimmer. */
function Placeholder({ className }: { readonly className: string }) {
  return <View className={`rounded-lg bg-surface ${className}`} />;
}

/** Two rails' worth of placeholders while Home's first answer is on its way. */
export function HomeSkeleton() {
  return (
    <View accessible accessibilityLabel="Loading your music">
      {[0, 1].map((rail) => (
        <View key={rail} className={rail === 0 ? "pt-4" : "pt-mobile-edge"}>
          <Placeholder className="mb-3 h-ios-28 w-ios-200" />
          <View className="flex-row gap-3">
            <Placeholder className="size-ios-168" />
            <Placeholder className="size-ios-168" />
          </View>
        </View>
      ))}
    </View>
  );
}

/** A summary line's placeholder, for Library's totals before they arrive. */
export function LinePlaceholder() {
  return (
    <View accessible accessibilityLabel="Loading" className="py-1">
      <View className="h-3 w-ios-200 rounded-sm bg-surface" />
    </View>
  );
}

/** G02's notice while a library is being read, with the songs found so far; nothing otherwise. */
export function ScanNotice({ tracks }: { readonly tracks: number }) {
  if (useScanning() !== true) return null;

  return (
    <Notice
      icon={RotateCw}
      title="Reading your collection"
      body={`${countOf(tracks, "song")} found · The scan continues in the background.`}
      className="mb-1"
    />
  );
}

/**
 * G02's placeholders under the rails while a scan is still adding music; admins can follow the
 * scan in Jobs. Nothing otherwise.
 */
export function MoreOnTheWay() {
  const scanning = useScanning();
  const me = useRead("account.me", {});

  if (scanning !== true) return null;

  return (
    <View>
      <SectionHeader
        title="More on the way"
        action={
          me !== undefined && can(me.role, "admin")
            ? { kind: "chevron", onPress: () => router.push("/settings/admin/jobs") }
            : undefined
        }
      />
      <View className="flex-row gap-3">
        <Placeholder className="h-ios-104 w-ios-168" />
        <Placeholder className="h-ios-104 w-ios-168" />
      </View>
    </View>
  );
}

/**
 * Home with nothing to play: G02 while the first songs are still being found, else G01. Admins
 * can add a folder; anyone else hears music once a library is shared with them.
 */
export function EmptyHome() {
  const scanning = useScanning();
  const me = useRead("account.me", {});

  if (scanning === undefined || me === undefined) return <HomeSkeleton />;

  if (scanning) {
    return (
      <>
        <ScanNotice tracks={0} />
        <MoreOnTheWay />
      </>
    );
  }

  if (!can(me.role, "admin")) {
    return (
      <EmptyState
        icon={Music}
        title={"Nothing to play\nyet."}
        body={"Music shows up here once an\nadmin shares a library with you."}
      />
    );
  }

  return (
    <EmptyState
      icon={Folder}
      title={"Your collection\nstarts here."}
      body={"Add a folder on your server.\nWe’ll take it from there."}
      primary={
        <Button
          label="Add library folder"
          onPress={() => router.push("/settings/admin/libraries/new")}
        />
      }
    />
  );
}
