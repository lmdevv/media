import type { DeviceId } from "@music/commands/ids";
import type { Device } from "@music/commands/models";
import { usePlayer, usePlayerPosition } from "@music/player/react";
import { useRead } from "@music/sdk/react";
import { Spinner } from "@music/ui/components/spinner";
import { cn } from "@music/ui/lib/utils";
import { MonitorIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { PlayingBars } from "@/components/library/artwork";
import { toastFailure } from "@/lib/action";
import { formatAgo, formatDuration } from "@/lib/format";

import { deviceIcon } from "./controls";

const TRANSFER_TIMEOUT_MS = 10_000;

const KIND_LABEL = { web: "Browser", phone: "Phone", cli: "Terminal" } as const;

const idleLabel = (device: Device, now: number): string => {
  if (device.online) return "active now";

  const minutes = Math.floor((now - device.lastSeenAt) / 60_000);

  return minutes < 60
    ? `idle ${Math.max(1, minutes)} min`
    : `last seen ${formatAgo(device.lastSeenAt, now)}`;
};

/** Your other devices and the transfer that is starting, if any. */
export interface DevicesState {
  /** Devices other than this browser, most recently seen first. */
  readonly others: ReadonlyArray<Device>;
  /** This browser's own entry, once the server lists it. */
  readonly self: Device | null;
  readonly onlineCount: number;
  /** The device a transfer is waiting on; `here` is this browser. */
  readonly pending: DeviceId | "here" | null;
  readonly transfer: (target: DeviceId | "here") => void;
}

/** The devices you can play on, which one plays, and a transfer in progress. */
export const useDevices = (): DevicesState => {
  const player = usePlayer();
  const devices = useRead("devices.list", {});
  const [pending, setPending] = useState<DeviceId | "here" | null>(null);
  const others = (devices ?? []).filter((device) => device.id !== player.deviceId);
  const activeId = player.activeDevice?.id ?? null;

  useEffect(() => {
    if (pending === null) return undefined;

    const arrived = pending === "here" ? player.isThisDevice : activeId === pending;

    if (arrived) {
      setPending(null);

      return undefined;
    }

    const timer = window.setTimeout(() => {
      setPending(null);
      toast.error("That device didn't respond. Check that it's online and try again.");
    }, TRANSFER_TIMEOUT_MS);

    return () => window.clearTimeout(timer);
  }, [pending, activeId, player.isThisDevice]);

  const transfer = (target: DeviceId | "here") => {
    if (target === "here" ? player.isThisDevice : target === activeId) return;

    setPending(target);
    (target === "here" ? player.playHere() : player.transferTo(target)).catch((cause: unknown) => {
      setPending(null);
      toastFailure(cause);
    });
  };

  return {
    others,
    self: (devices ?? []).find((device) => device.id === player.deviceId) ?? null,
    onlineCount: (devices ?? []).filter((device) => device.online).length,
    pending,
    transfer,
  };
};

/**
 * The "Play on" list shared by the desktop popover and the phone sheet: this browser first, then
 * your other devices, with the playing one marked and a transfer shown as it starts.
 */
export function DeviceList({ touch = false }: { readonly touch?: boolean }) {
  const player = usePlayer();
  const position = usePlayerPosition();
  const { others, self, pending, transfer } = useDevices();
  const now = Date.now();
  const activeId = player.activeDevice?.id ?? null;
  const playing = player.status === "playing";

  const pendingName =
    pending === "here"
      ? "this browser"
      : (others.find((device) => device.id === pending)?.name ?? "");

  const row = (
    key: string,
    props: {
      readonly name: string;
      readonly detail: string;
      readonly Icon: typeof MonitorIcon;
      readonly active: boolean;
      readonly isPending: boolean;
      readonly onSelect: () => void;
      readonly disabled?: boolean;
    },
  ) => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={props.active}
      disabled={props.disabled}
      onClick={props.onSelect}
      className={cn(
        "flex w-full shrink-0 items-center gap-3 rounded-md border-[1.5px] border-transparent px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-(--opacity-disabled)",
        touch ? "h-16 gap-3.5 px-3.5" : "h-row-touch",
        props.active && "bg-surface",
        props.isPending && "border-accent",
        !props.active && !props.isPending && "hover:bg-surface",
      )}
    >
      <props.Icon
        className={cn(
          "shrink-0",
          touch ? "size-6" : "size-[22px]",
          props.active ? "text-text" : "text-text-muted",
        )}
      />
      <span className="flex min-w-0 grow flex-col gap-px">
        <span
          className={cn(
            "truncate font-sans text-text",
            touch ? "text-md/base" : "text-base/sm",
            props.active && "font-semibold",
          )}
        >
          {props.name}
        </span>
        <span className="truncate font-sans text-sm/xs text-text-muted">{props.detail}</span>
      </span>
      {props.isPending ? <Spinner label="Starting" className="size-5 text-text" /> : null}
      {props.active && !props.isPending && playing ? <PlayingBars /> : null}
    </button>
  );

  return (
    // Old browsers stay listed as idle, so the list scrolls instead of outgrowing the screen.
    <div
      role="menu"
      aria-label="Play on"
      className="flex max-h-[min(440px,60dvh)] flex-col gap-0.5 overflow-y-auto overscroll-contain"
    >
      {row("here", {
        name: "This browser",
        detail: player.isThisDevice
          ? pending === null
            ? playing
              ? "Playing"
              : "Ready"
            : `Will pause when ${pendingName} starts`
          : pending === "here"
            ? `Starting at ${formatDuration(position)}…`
            : "Play here",
        Icon: deviceIcon(self?.kind ?? "web"),
        active: player.isThisDevice,
        isPending: pending === "here",
        onSelect: () => transfer("here"),
      })}
      {others.map((device) => {
        const active = device.id === activeId;
        const isPending = device.id === pending;

        return row(device.id, {
          name: device.name,
          detail: isPending
            ? `Starting at ${formatDuration(position)}…`
            : active
              ? `${KIND_LABEL[device.kind]} · ${pending === null ? (playing ? "playing" : "paused") : `will pause when ${pendingName} starts`}`
              : `${KIND_LABEL[device.kind]} · ${idleLabel(device, now)}`,
          Icon:
            device.kind === "web" && device.name.toLowerCase().includes("room")
              ? MonitorIcon
              : deviceIcon(device.kind),
          active,
          isPending,
          disabled: device.kind === "cli",
          onSelect: () => transfer(device.id),
        });
      })}
      {others.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 px-6 pt-5 pb-3 text-center">
          <span className="font-sans text-base/sm font-medium text-text">
            No other devices right now
          </span>
          <span className="font-sans text-sm/sm text-text-muted">
            Open [music] on your phone or another computer and sign in. It appears here within a few
            seconds.
          </span>
        </div>
      ) : null}
    </div>
  );
}
