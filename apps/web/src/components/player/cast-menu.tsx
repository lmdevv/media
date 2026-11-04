import { Popover } from "@base-ui/react/popover";
import { cn } from "@media/ui/lib/utils";
import { AirplayIcon, CastIcon, MonitorSmartphoneIcon } from "lucide-react";
import { useState } from "react";
import type { ReactElement, ReactNode } from "react";

/** The Chromecast row: connect, or the device playing and how to stop. */
export interface ChromecastOption {
  /** Chrome is connecting to a device, which the page cannot cancel. */
  readonly connecting: boolean;
  /** Connected and loading the stream on the device; cancelling disconnects. */
  readonly starting: boolean;
  /** The device playing now, or null. */
  readonly deviceName: string | null;
  /** The media service's address is local to this computer, which a Chromecast cannot reach. */
  readonly unreachable: boolean;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
}

/** A browser device picker row (AirPlay, Remote Playback). */
export interface PickerOption {
  readonly active: boolean;
  readonly onChoose: () => void;
}

function MenuRow({
  icon,
  label,
  detail,
  onClick,
  disabled = false,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly detail: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex cursor-pointer items-center gap-3 rounded-bar p-2 text-left font-sans text-body/label text-text transition-colors hover:bg-text/8 disabled:cursor-default disabled:opacity-(--opacity-disabled) [&_svg]:size-5 [&_svg]:shrink-0"
    >
      {icon}
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="truncate font-semibold">{label}</span>
        <span className="truncate text-caption/caption text-text-muted">{detail}</span>
      </span>
    </button>
  );
}

function ChromecastRow({
  chromecast,
  choose,
}: {
  readonly chromecast: ChromecastOption;
  readonly choose: (action: () => void) => () => void;
}) {
  const icon = <CastIcon strokeWidth={1.75} aria-hidden />;

  // Chrome's connection to a device cannot be cancelled from the page, so the row waits for it.
  const row =
    chromecast.deviceName !== null ? (
      <MenuRow
        icon={icon}
        label="Stop casting"
        detail={`Playing on ${chromecast.deviceName}`}
        onClick={choose(chromecast.onDisconnect)}
      />
    ) : chromecast.starting ? (
      <MenuRow
        icon={icon}
        label="Cancel casting"
        detail="Connecting…"
        onClick={choose(chromecast.onDisconnect)}
      />
    ) : (
      <MenuRow
        icon={icon}
        label="Chromecast"
        detail={chromecast.connecting ? "Connecting…" : "Choose a device"}
        disabled={chromecast.connecting}
        onClick={choose(chromecast.onConnect)}
      />
    );

  return (
    <>
      {row}
      {chromecast.unreachable ? (
        <p role="note" className="px-2 pb-1 font-sans text-caption/caption text-warning">
          This server is open at a local address. A Chromecast can't reach it; open [movies] at its
          network address to cast.
        </p>
      ) : null}
    </>
  );
}

/**
 * The cast menu above the player's cast button. Choosing a row closes it and opens the browser's
 * device picker, or stops the cast.
 *
 * @param container - Where it renders; pass the full-screen element so it stays visible there.
 */
export function CastMenu({
  trigger,
  container,
  chromecast,
  airplay,
  otherDevices,
}: {
  readonly trigger: ReactElement;
  readonly container?: HTMLElement | null | undefined;
  readonly chromecast: ChromecastOption | null;
  readonly airplay: PickerOption | null;
  readonly otherDevices: PickerOption | null;
}) {
  const [open, setOpen] = useState(false);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal container={container}>
        <Popover.Positioner
          side="bottom"
          align="end"
          sideOffset={12}
          collisionPadding={16}
          className="z-50"
        >
          <Popover.Popup
            aria-label="Play on"
            className="origin-(--transform-origin) shadow-overlay transition-[opacity,scale] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
          >
            <div
              data-slot="cast-menu"
              className="flex w-80 flex-col gap-0.5 rounded-control border border-hairline bg-surface-raised p-3"
            >
              <span className="px-2 pt-2 pb-2.5 font-sans text-caption/caption font-medium tracking-caps text-text-muted uppercase">
                Play on
              </span>
              {chromecast === null ? null : (
                <ChromecastRow chromecast={chromecast} choose={choose} />
              )}
              {airplay === null ? null : (
                <MenuRow
                  icon={<AirplayIcon strokeWidth={1.75} aria-hidden />}
                  label="AirPlay"
                  detail={airplay.active ? "Playing on AirPlay" : "Choose a device"}
                  onClick={choose(airplay.onChoose)}
                />
              )}
              {otherDevices === null ? null : (
                <MenuRow
                  icon={<MonitorSmartphoneIcon strokeWidth={1.75} aria-hidden />}
                  label="Other devices"
                  detail={otherDevices.active ? "Playing on another device" : "Choose a device"}
                  onClick={choose(otherDevices.onChoose)}
                />
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Over the video while a TV plays: which device, centered on the dimmed frame. */
export function CastingState({
  deviceName,
  className,
}: {
  readonly deviceName: string;
  readonly className?: string;
}) {
  return (
    <div
      data-testid="casting-state"
      role="status"
      className={cn(
        "on-media pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-dark-bg/70 font-sans",
        className,
      )}
    >
      <CastIcon className="size-10 text-text" strokeWidth={1.5} aria-hidden />
      <p className="text-lead/body font-semibold text-text">Playing on {deviceName}</p>
    </div>
  );
}
