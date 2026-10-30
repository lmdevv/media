/**
 * The design system on one page, as Paper's "04 · Mobile components and tokens" board lays it out,
 * for checking components against Paper and both themes on a device. Not linked from the app:
 * open `music:///components` (for example with `xcrun simctl openurl`). A Release build sends the
 * link home instead.
 */
import { Check, Info, Play, Shuffle } from "lucide-react-native";
import { Redirect } from "expo-router";
import { useRef, useState } from "react";
import { View } from "react-native";

import { DeviceSheetPreview } from "@/components/playback/device-sheet-preview";
import { HomeSkeleton } from "@/components/states/home-states";
import { useSave } from "@/components/states/save-failure";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ChipGroup } from "@/components/ui/chip";
import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowCheck, RowChevron, RowMore } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { loadAppearance, saveAppearance } from "@/lib/appearance";
import type { Appearance } from "@/lib/appearance";

const APPEARANCES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

const SCOPES = [
  { value: "yours", label: "Yours" },
  { value: "shared", label: "Shared" },
] as const;

/** Waits, then fails, to show the pending and failure states of a form. */
const failSoon = () =>
  new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error("Couldn’t save changes")), 1200);
  });

/** A one-tap save the server refuses, to open G13: Try again fails once more, then lands. */
function FailedSaveDemo() {
  const save = useSave();
  const tries = useRef(0);

  const attempt = async () => {
    tries.current += 1;
    await new Promise((resolve) => setTimeout(resolve, 800));

    if (tries.current % 3 !== 0) throw new Error("The server didn’t answer in time.");
  };

  return (
    <Button
      label="Like a song"
      variant="secondary"
      onPress={() => void save(attempt, "This song isn’t in your liked songs.")}
    />
  );
}

export default function Components() {
  return __DEV__ ? <Gallery /> : <Redirect href="/" />;
}

function Gallery() {
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
  const [scope, setScope] = useState<(typeof SCOPES)[number]["value"]>("yours");
  const [autoplay, setAutoplay] = useState(true);
  const [name, setName] = useState("Late night");

  return (
    <Page title="Components" bottom="plain">
      <ChipGroup
        label="Appearance"
        options={APPEARANCES}
        value={appearance}
        onChange={(next) => {
          setAppearance(next);
          saveAppearance(next);
        }}
      />
      <SectionHeader title="Type and controls" action={{ kind: "chevron", onPress: () => {} }} />
      <Text variant="largeTitle">Library</Text>
      <Text variant="section">Recently added</Text>
      <Text variant="bodyMedium">Unfinished Sympathy</Text>
      <Text variant="secondary" tone="muted">
        Massive Attack
      </Text>
      <Text variant="mono" tone="muted">
        FLAC · 16-BIT / 44.1 KHZ
      </Text>
      <View className="flex-row gap-3 py-4">
        <Button label="Play" icon={Play} iconFilled className="flex-1" />
        <Button label="Shuffle" icon={Shuffle} variant="secondary" className="flex-1" />
      </View>
      <Button label="Remove" variant="destructive" pending pendingLabel="Removing…" />
      <Field
        label="Playlist name"
        value={name}
        onChangeText={setName}
        helper="Shown to people you share it with."
      />
      <ChipGroup label="Playlists" options={SCOPES} value={scope} onChange={setScope} />
      <View className="min-h-ios-72 flex-row items-center gap-4 border-b border-border py-3">
        <View className="flex-1 gap-1">
          <Text variant="bodyMedium">Autoplay</Text>
          <Text variant="secondary" tone="muted">
            Music from your own library.
          </Text>
        </View>
        <Switch label="Autoplay" value={autoplay} onValueChange={setAutoplay} />
      </View>
      <SectionHeader title="Rows and artwork" />
      <Row
        title="Unfinished Sympathy"
        subtitle="Massive Attack"
        leading={{ kind: "art", url: null }}
        trailingAction={<RowMore label="More, Unfinished Sympathy" onPress={() => {}} />}
        active
        onPress={() => {}}
      />
      <Row
        title="Safe from Harm"
        subtitle="Massive Attack"
        leading={{ kind: "art", url: null }}
        trailingAction={<RowMore label="More, Safe from Harm" onPress={() => {}} />}
        onPress={() => {}}
      />
      <Row
        title="Albums"
        subtitle="Every record, in one place"
        leading={{ kind: "icon", icon: Info }}
        trailing={<RowChevron />}
        onPress={() => {}}
      />
      <Row
        title="This iPhone"
        subtitle="Playing here"
        leading={{ kind: "icon", icon: Check, tone: "muted" }}
        trailing={<RowCheck />}
      />
      <SectionHeader
        title="Theme and feedback"
        action={{ kind: "link", label: "See all", onPress: () => {} }}
      />
      <View className="flex-row items-center gap-3 pb-4">
        <Avatar name="Lee" />
        <View className="h-12 w-ios-72 rounded-md border border-border bg-bg" />
        <View className="h-12 w-ios-72 rounded-md border border-border bg-surface" />
        <View className="h-12 w-ios-72 rounded-md border border-border bg-accent" />
      </View>
      <Notice
        icon={Check}
        title="Added to Late night"
        body="Quiet confirmation after adding a song."
      />
      <Notice
        icon={Info}
        title="Couldn’t save changes"
        body="Keep the form open and offer Retry."
        className="mt-3"
      />
      <View className="bleed-page mt-6 border-t border-border">
        <ConfirmSheet
          title="Clear queue?"
          body="Everything after the current song is removed from your queue."
          confirmLabel="Clear queue"
          pendingLabel="Clearing…"
          onConfirm={failSoon}
        />
      </View>
      <DeviceSheetPreview />
      <SectionHeader title="Loading" />
      <HomeSkeleton />
      <SectionHeader title="Failed save" />
      <FailedSaveDemo />
    </Page>
  );
}
