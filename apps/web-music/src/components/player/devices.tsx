import { localOnly } from "@media/contracts/cast";
import { deviceKind, outputLabel } from "@media/player/connect-devices";
import type { Device } from "@media/player/react";
import { usePlayer, usePlayerPosition } from "@media/player/react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { AirplayIcon, CastIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useCast } from "@/casting/cast-provider";
import type { MusicCast } from "@/casting/cast-provider";
import { useJoinedJam } from "@/components/jam/jam";
import { JamButton } from "@/components/jam/jam-band";
import { PlayingBars } from "@/components/library/artwork";
import { useUi } from "@/components/shell/ui-state";
import { Spinner } from "@/components/ui/spinner";
import { MEDIA_BASE_URL } from "@/env";
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
 * The devices you can play on, which one plays, and a move in progress. A move waits until the
 * device it went to answers it, and gives up after 10 seconds.
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
  /** An action rather than a place to play, such as connecting a Chromecast. */
  readonly action?: boolean;
  readonly disabled?: boolean;
}

function DeviceRow({
  name,
  detail,
  Icon,
  active,
  isPending,
  playing,
  touch,
  onSelect,
  action = false,
  disabled = false,
}: RowProps) {
  return (
    <button
      type="button"
      role={action ? "menuitem" : "menuitemradio"}
      aria-checked={action ? undefined : active}
      disabled={disabled}
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

/** The icon of a device that plays through a receiver, by the receiver's kind. */
const OUTPUT_ICONS = { cast: CastIcon, airplay: AirplayIcon } as const;

/**
 * The Chromecast row: connect this browser to a Chromecast, which then plays what plays here, or
 * stop casting; either closes "Play on". Chrome's connection cannot be cancelled from the page, so
 * the row waits for it.
 * A media server open at a local address is out of a Chromecast's reach, which a note says.
 */
function ChromecastRow({ cast, touch }: { readonly cast: MusicCast; readonly touch: boolean }) {
  const { device } = cast;
  const { closePlayOn } = useUi();

  return (
    <>
      <DeviceRow
        name={device === null ? "Chromecast" : "Stop casting"}
        detail={
          device === null
            ? cast.connecting
              ? "Connecting…"
              : "Choose a device"
            : `Playing on ${device.name ?? "your TV"}`
        }
        Icon={CastIcon}
        active={false}
        isPending={false}
        playing={false}
        touch={touch}
        action
        disabled={device === null && cast.connecting}
        onSelect={() => {
          // Chrome's device picker opens over the page, or the music comes back here.
          closePlayOn();

          if (device === null) cast.connect();
          else cast.disconnect();
        }}
      />
      {localOnly(MEDIA_BASE_URL) ? (
        <p role="note" className="px-3 pb-1 font-sans text-sm/xs text-text-muted">
          This server is open at a local address. A Chromecast can't reach it; open Lar Music at its
          network address to cast.
        </p>
      ) : null}
    </>
  );
}

/**
 * The "Play on" list shared by the desktop popover and the phone sheet: this browser first, then
 * a Chromecast it can play through, then your other devices, with the playing one marked, each
 * device's Chromecast or AirPlay receiver named, and a move shown as it starts, and the Jam button.
 * A Jam plays here and offers no other device or Chromecast (ADR 0017).
 */
export function DeviceList({ touch = false }: { readonly touch?: boolean }) {
  const player = usePlayer();
  const jam = useJoinedJam();
  const position = usePlayerPosition();
  const { others, pending, transfer } = useDevices();
  const cast = useCast();
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

  const castingTo = player.cast === null ? null : `Casting to ${player.cast.receiver ?? "your TV"}`;

  const hereDetail = (): string => {
    if (!player.here) return target === "here" ? starting : (castingTo ?? "Play here");

    if (pending !== null) return `Will pause when ${pendingName} starts`;

    if (castingTo !== null) return castingTo;

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
        Icon={player.cast === null ? deviceIcon(thisBrowserKind()) : CastIcon}
        active={player.here}
        isPending={target === "here"}
        playing={playing}
        touch={touch}
        onSelect={() => transfer("here")}
      />
      {jam === null && (cast.available || cast.device !== null) ? (
        <ChromecastRow cast={cast} touch={touch} />
      ) : null}
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

        const { output } = device;

        const detail = isPending
          ? starting
          : `${outputLabel(output) ?? KIND_LABEL[kind]} · ${active ? state : "active now"}`;

        return (
          <DeviceRow
            key={device.id}
            name={device.name}
            detail={detail}
            Icon={output.kind === "local" ? deviceIcon(kind) : OUTPUT_ICONS[output.kind]}
            active={active}
            isPending={isPending}
            playing={playing}
            touch={touch}
            onSelect={() => transfer({ device: device.id })}
          />
        );
      })}
      <div className="flex justify-center px-3 pt-2 pb-1">
        <JamButton />
      </div>
      {others.length === 0 && jam === null ? (
        <div className="flex flex-col items-center gap-1.5 px-6 pt-5 pb-3 text-center">
          <span className="font-sans text-base/sm font-medium text-text">
            No other devices right now
          </span>
        </div>
      ) : null}
    </div>
  );
}
