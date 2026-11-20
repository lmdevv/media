/**
 * The player's sleep timer: the native menu behind its round button (the preset lengths, the end
 * of the episode, a custom length, and turning it off) and the panel that takes a custom length on
 * two wheels.
 */
import {
  Divider,
  Host,
  Menu,
  Button as MenuButton,
  Picker,
  RNHostView,
  Text as WheelText,
} from "@expo/ui/swift-ui";
import {
  clipped,
  frame,
  labelsHidden,
  onDisappear,
  pickerStyle,
  tag,
} from "@expo/ui/swift-ui/modifiers";
import {
  SLEEP_MAX_HOURS,
  SLEEP_PRESET_MINUTES,
  customSleepMinutes,
} from "@media/contracts/sleep-timer";
import type { SleepChoice } from "@media/contracts/sleep-timer";
import { Moon } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";

import { SidePanel } from "./side-panel";

/** What the sleep timer's button shows and does. */
export interface SleepTimerButton {
  /** The running timer's time left, such as `29:41`; null when none runs or it is not known yet. */
  readonly timeLeft: string | null;
  /** The episode playing, which offers its end; null for a movie. */
  readonly itemKey: string | null;
  readonly onChoose: (choice: SleepChoice) => void;
  /** Opens the panel that takes a custom length. */
  readonly onCustom: () => void;
  /** Turns the running timer off; null when none runs. */
  readonly onCancel: (() => void) | null;
}

const presetLabel = (minutes: number): string => {
  if (minutes < 60) return `${String(minutes)} Minutes`;

  return minutes === 60 ? "1 Hour" : `${String(minutes / 60)} Hours`;
};

/**
 * The round moon button left of AirPlay and its native menu; while a timer runs, its time left
 * shows beside the moon. Touching it holds the controls up, as `MoreMenu` does, until an item is
 * picked or the menu is dismissed.
 */
export function SleepTimerMenu({
  timer,
  onOpen,
  onRelease,
}: {
  readonly timer: SleepTimerButton;
  readonly onOpen: () => void;
  readonly onRelease: () => void;
}) {
  const { timeLeft, itemKey, onCancel } = timer;
  const release = [onDisappear(onRelease)];

  const pick = (action: () => void) => () => {
    onRelease();
    action();
  };

  return (
    <View onTouchStart={onOpen}>
      <Host matchContents>
        <Menu
          label={
            <RNHostView matchContents>
              <View
                accessible
                accessibilityRole="button"
                accessibilityLabel="Sleep Timer"
                accessibilityValue={timeLeft === null ? undefined : { text: `${timeLeft} left` }}
                className={`h-11 min-w-11 flex-row items-center justify-center gap-1.5 rounded-pill bg-dark-surface-raised/80 ${timeLeft === null ? "" : "px-3.5"}`}
              >
                <Icon icon={Moon} tone="onMedia" />
                {timeLeft === null ? null : (
                  <Text variant="monoMedium" tone="onMedia">
                    {timeLeft}
                  </Text>
                )}
              </View>
            </RNHostView>
          }
        >
          {SLEEP_PRESET_MINUTES.map((minutes) => (
            <MenuButton
              key={minutes}
              label={presetLabel(minutes)}
              modifiers={release}
              onPress={pick(() => timer.onChoose({ kind: "after", minutes }))}
            />
          ))}
          <Divider />
          {itemKey === null ? null : (
            <MenuButton
              label="End of This Episode"
              modifiers={release}
              onPress={pick(() => timer.onChoose({ kind: "itemEnd", itemKey }))}
            />
          )}
          <MenuButton label="Custom…" modifiers={release} onPress={pick(timer.onCustom)} />
          {onCancel === null ? null : (
            <MenuButton
              label="Turn Off Timer"
              role="destructive"
              modifiers={release}
              onPress={pick(onCancel)}
            />
          )}
        </Menu>
      </Host>
    </View>
  );
}

const HOURS = Array.from({ length: SLEEP_MAX_HOURS + 1 }, (_, hours) => hours);

const MINUTES = Array.from({ length: 60 }, (_, minutes) => minutes);

/** One wheel of the custom timer, in its own host so its touches stay inside its frame. */
function Wheel({
  label,
  values,
  unit,
  selection,
  onSelection,
}: {
  readonly label: string;
  readonly values: ReadonlyArray<number>;
  readonly unit: (value: number) => string;
  readonly selection: number;
  readonly onSelection: (value: number) => void;
}) {
  return (
    <Host matchContents colorScheme="dark">
      <Picker
        label={label}
        selection={selection}
        onSelectionChange={onSelection}
        modifiers={[
          pickerStyle("wheel"),
          labelsHidden(),
          frame({ width: 140, height: 160 }),
          clipped(),
        ]}
      >
        {values.map((value) => (
          <WheelText key={value} modifiers={[tag(value)]}>
            {unit(value)}
          </WheelText>
        ))}
      </Picker>
    </Host>
  );
}

/** A custom sleep timer: hours and minutes on two wheels, then Start Timer. */
export function SleepTimerPanel({
  onStart,
  onClose,
}: {
  /** Starts a timer of this many minutes. */
  readonly onStart: (minutes: number) => void;
  readonly onClose: () => void;
}) {
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(30);
  const total = customSleepMinutes(hours, minutes);

  return (
    <SidePanel title="Custom Sleep Timer" widthClassName="w-100" onClose={onClose}>
      <View className="flex-1 flex-row items-center justify-center">
        <Wheel
          label="Hours"
          values={HOURS}
          unit={(value) => (value === 1 ? "1 hour" : `${String(value)} hours`)}
          selection={hours}
          onSelection={setHours}
        />
        <Wheel
          label="Minutes"
          values={MINUTES}
          unit={(value) => `${String(value)} min`}
          selection={minutes}
          onSelection={setMinutes}
        />
      </View>
      <Button
        label="Start Timer"
        disabled={total === null}
        onPress={() => {
          if (total !== null) onStart(total);
        }}
      />
    </SidePanel>
  );
}
