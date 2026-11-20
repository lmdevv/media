/**
 * The player's sleep timer: the menu behind its button (the preset lengths, the end of the
 * episode, a custom length, and turning it off) and the dialog that takes a custom length.
 */
import {
  SLEEP_MAX_HOURS,
  SLEEP_PRESET_MINUTES,
  customSleepMinutes,
} from "@media/contracts/sleep-timer";
import type { SleepChoice } from "@media/contracts/sleep-timer";
import { Button } from "@media/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@media/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@media/ui/components/dropdown-menu";
import { FieldError, TextField } from "@media/ui/components/text-field";
import { useState } from "react";
import type { ReactElement } from "react";

const SLEEP_TIMER_LABEL = "Sleep timer";

/** The sleep timer button's accessible name, with the time left while a timer runs. */
export const sleepTimerButtonLabel = (timeLeft: string | null): string =>
  timeLeft === null ? SLEEP_TIMER_LABEL : `${SLEEP_TIMER_LABEL}, ${timeLeft} left`;

const ITEM_CLASS = "rounded-bar p-2 text-body/label text-text focus:bg-text/8";

const presetLabel = (minutes: number): string => {
  if (minutes < 60) return `${String(minutes)} minutes`;

  return minutes === 60 ? "1 hour" : `${String(minutes / 60)} hours`;
};

/**
 * The menu above the sleep timer's button. Choosing a length or the end of the episode starts the
 * timer over; Custom… asks the player to open the custom dialog.
 *
 * @param container - Where it renders; pass the full-screen element so it stays visible there.
 * @param timeLeft - The running timer's time left, such as `29:41`; null when none runs or it is
 *   not known yet.
 * @param itemKey - The episode playing, which offers its end; null for a movie.
 * @param onCancel - Turns the running timer off; null when none runs.
 */
export function SleepTimerMenu({
  trigger,
  container,
  timeLeft,
  itemKey,
  onChoose,
  onCustom,
  onCancel,
}: {
  readonly trigger: ReactElement;
  readonly container?: HTMLElement | null | undefined;
  readonly timeLeft: string | null;
  readonly itemKey: string | null;
  readonly onChoose: (choice: SleepChoice) => void;
  readonly onCustom: () => void;
  readonly onCancel: (() => void) | null;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent
        container={container}
        side="bottom"
        align="end"
        sideOffset={12}
        aria-label={SLEEP_TIMER_LABEL}
        className="w-64 p-3"
      >
        <span className="flex justify-between px-2 pt-2 pb-2.5 font-sans text-caption/caption font-medium tracking-caps text-text-muted uppercase">
          {SLEEP_TIMER_LABEL}
          {timeLeft === null ? null : <span className="tabular-nums">{timeLeft} left</span>}
        </span>
        {SLEEP_PRESET_MINUTES.map((minutes) => (
          <DropdownMenuItem
            key={minutes}
            className={ITEM_CLASS}
            onClick={() => onChoose({ kind: "after", minutes })}
          >
            {presetLabel(minutes)}
          </DropdownMenuItem>
        ))}
        {itemKey === null ? null : (
          <DropdownMenuItem
            className={ITEM_CLASS}
            onClick={() => onChoose({ kind: "itemEnd", itemKey })}
          >
            End of this episode
          </DropdownMenuItem>
        )}
        <DropdownMenuItem className={ITEM_CLASS} onClick={onCustom}>
          Custom…
        </DropdownMenuItem>
        {onCancel === null ? null : (
          <DropdownMenuItem className={ITEM_CLASS} onClick={onCancel}>
            Turn off timer
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CustomTimerForm({ onStart }: { readonly onStart: (minutes: number) => void }) {
  const [hours, setHours] = useState("0");
  const [minutes, setMinutes] = useState("30");
  const [invalid, setInvalid] = useState(false);

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();

        const total = customSleepMinutes(Number(hours), Number(minutes));

        if (total === null) setInvalid(true);
        else onStart(total);
      }}
    >
      <DialogBody className="gap-2">
        <div className="flex gap-4">
          <TextField
            className="flex-1"
            label="Hours"
            type="number"
            inputMode="numeric"
            min={0}
            max={SLEEP_MAX_HOURS}
            step={1}
            value={hours}
            aria-invalid={invalid || undefined}
            onChange={(event) => {
              setHours(event.target.value);
              setInvalid(false);
            }}
          />
          <TextField
            className="flex-1"
            label="Minutes"
            type="number"
            inputMode="numeric"
            min={0}
            max={59}
            step={1}
            value={minutes}
            aria-invalid={invalid || undefined}
            onChange={(event) => {
              setMinutes(event.target.value);
              setInvalid(false);
            }}
          />
        </div>
        {invalid ? (
          <FieldError>
            Choose from 1 minute to {String(SLEEP_MAX_HOURS)} hours 59 minutes.
          </FieldError>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" size="dialog" />}>Cancel</DialogClose>
        <Button type="submit" size="dialog">
          Start timer
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Asks for a custom sleep timer in hours and minutes, over the player.
 *
 * @param container - Where the dialog renders; the body when undefined.
 * @param onStart - Starts a timer of this many minutes; the dialog closes itself.
 */
export function CustomSleepTimerDialog({
  open,
  container,
  onOpenChange,
  onStart,
}: {
  readonly open: boolean;
  readonly container: HTMLElement | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onStart: (minutes: number) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Custom sleep timer" size="sm" container={container} className="dark">
        <CustomTimerForm
          onStart={(minutes) => {
            onOpenChange(false);
            onStart(minutes);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
