import { deviceKind } from "@media/player/connect-devices";
import type { Device } from "@media/player/react";
import { usePlayer, usePlayerPosition } from "@media/player/react";
import { useHotkey } from "@tanstack/react-hotkeys";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { PlayingBars } from "@/components/library/artwork";
import { useUi } from "@/components/shell/ui-state";
import { Spinner } from "@/components/ui/spinner";
import { formatDuration } from "@/lib/format";
import { HOTKEYS } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";

import { KIND_LABEL, deviceIcon, moveDone, thisBrowserKind } from "./player-actions";
import type { MoveTarget, PendingMove } from "./player-actions";

const TRANSFER_TIMEOUT_MS = 10_000;

const isDevice = (target: MoveTarget | null, deviceId: string): boolean =>
  target !== null && target !== "here" && target.device === deviceId;

/** Your other devices and the move that is starting, if any. */
interface DevicesState {
  /** Your other devices that are online, by name. */
  readonly others: ReadonlyArray<Device>;
  readonly pending: PendingMove | null;
  readonly transfer: (target: MoveTarget) => void;
}

/**
 * The devices you can play on, which one plays, and a move in progress, as old music's device list
 * showed them. A move waits until the device it went to answers it, and gives up after 10 seconds.
 */
const useDevices = (): DevicesState => {
  const player = usePlayer();
  const [pending, setPending] = useState<PendingMove | null>(null);
  const moves = useRef(0);
  const activeId = player.remote?.id ?? null;
  const arrived = pending !== null && moveDone(pending, player);

  if (pending !== null && arrived) setPending(null);

  const waiting = arrived ? null : pending;
  const waitingFor = waiting?.id ?? null;

  useEffect(() => {
    if (waitingFor === null) return undefined;

    const timer = window.setTimeout(() => {
      setPending((current) => (current?.id === waitingFor ? null : current));
      toast.error("That device didn't respond. Check that it's online and try again.");
    }, TRANSFER_TIMEOUT_MS);

    return () => window.clearTimeout(timer);
  }, [waitingFor]);

  const transfer = (target: MoveTarget) => {
    if (target === "here" && player.here) return;

    // Nothing is queued, so nothing moves here.
    if (target === "here" && activeId === null && player.track === null) return;

    const name =
      target === "here"
        ? "this browser"
        : (player.devices.find((device) => device.id === target.device)?.name ?? "");

    moves.current += 1;
    const id = moves.current;

    if (target !== "here" && target.device === activeId) {
      // The core holds a move there already, as one that timed out: wait again for its answer.
      const again: PendingMove = { id, target, name, landed: true };

      if (!moveDone(again, player)) setPending(again);

      return;
    }

    setPending({ id, target, name, landed: false });

    const move = async () => {
      if (await (target === "here" ? player.moveHere() : player.moveTo(target.device))) {
        setPending((current) => (current?.id === id ? { ...current, landed: true } : current));

        return;
      }

      setPending((current) => (current?.id === id ? null : current));
      toast.error("Couldn't move playback there. Try again.");
    };

    void move();
  };

  return {
    others: player.devices,
    pending: waiting,
    transfer,
  };
};

interface RowProps {
  readonly name: string;
  readonly detail: string;
  readonly Icon: LucideIcon;
  readonly active: boolean;
  readonly isPending: boolean;
  readonly playing: boolean;
  readonly touch: boolean;
  readonly onSelect: () => void;
}

function DeviceRow({ name, detail, Icon, active, isPending, playing, touch, onSelect }: RowProps) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "flex w-full shrink-0 items-center gap-3 rounded-md border-field border-transparent px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-(--opacity-disabled)",
        touch ? "h-16 gap-3.5 px-3.5" : "h-row-touch",
        active && "bg-surface",
        isPending && "border-accent",
        !active && !isPending && "hover:bg-surface",
      )}
    >
      <Icon
        className={cn(
          "shrink-0",
          touch ? "size-6" : "size-5.5",
          active ? "text-text" : "text-text-muted",
        )}
      />
      <span className="flex min-w-0 grow flex-col gap-px">
        <span
          className={cn(
            "truncate font-sans text-text",
            touch ? "text-md/base" : "text-base/sm",
            active && "font-semibold",
          )}
        >
          {name}
        </span>
        <span className="truncate font-sans text-sm/xs text-text-muted">{detail}</span>
      </span>
      {isPending ? <Spinner label="Starting" className="size-5 text-text" /> : null}
      {active && !isPending && playing ? <PlayingBars /> : null}
    </button>
  );
}

/**
 * The "Play on" list shared by the desktop popover and the phone sheet: this browser first, then
 * your other devices, with the playing one marked and a move shown as it starts.
 */
export function DeviceList({ touch = false }: { readonly touch?: boolean }) {
  const player = usePlayer();
  const position = usePlayerPosition();
  const { others, pending, transfer } = useDevices();
  const { closePlayOn } = useUi();
  const list = useRef<HTMLDivElement>(null);

  // TanStack leaves letters inside an ARIA menu to its typeahead, so the global D can't close
  // this list while focus is in it. Binding D on the list itself can.
  useHotkey(HOTKEYS["devices.toggle"], closePlayOn, { target: list });
  const activeId = player.remote?.id ?? null;
  const playing = player.status === "playing";
  const starting = `Starting at ${formatDuration(position)}…`;

  const target = pending?.target ?? null;
  const pendingName = pending?.name ?? "";

  const hereDetail = (): string => {
    if (!player.here) return target === "here" ? starting : "Play here";

    if (pending !== null) return `Will pause when ${pendingName} starts`;

    return playing ? "Playing" : "Ready";
  };

  return (
    <div
      ref={list}
      role="menu"
      aria-label="Play on"
      className="flex max-h-dvh-device-list flex-col gap-0.5 overflow-y-auto overscroll-contain"
    >
      <DeviceRow
        name="This browser"
        detail={hereDetail()}
        Icon={deviceIcon(thisBrowserKind())}
        active={player.here}
        isPending={target === "here"}
        playing={playing}
        touch={touch}
        onSelect={() => transfer("here")}
      />
      {others.map((device) => {
        const active = device.id === activeId;
        const isPending = isDevice(target, device.id);
        const kind = deviceKind(device.name);

        const state =
          pending === null
            ? playing
              ? "playing"
              : "paused"
            : `will pause when ${pendingName} starts`;

        const detail = isPending
          ? starting
          : `${KIND_LABEL[kind]} · ${active ? state : "active now"}`;

        return (
          <DeviceRow
            key={device.id}
            name={device.name}
            detail={detail}
            Icon={deviceIcon(kind)}
            active={active}
            isPending={isPending}
            playing={playing}
            touch={touch}
            onSelect={() => transfer({ device: device.id })}
          />
        );
      })}
      {others.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 px-6 pt-5 pb-3 text-center">
          <span className="font-sans text-base/sm font-medium text-text">
            No other devices right now
          </span>
        </div>
      ) : null}
    </div>
  );
}
