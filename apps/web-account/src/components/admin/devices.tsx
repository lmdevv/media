import { usePlatform } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { useState } from "react";

import { PageHeader } from "@/components/shell";
import type { UserId } from "@/session/platform-types";

import { useActions } from "./action";
import { useAllPages, usePages } from "./pages";
import type { Paged } from "./pages";
import { ItemRow, Notice, PagedList, SelectField } from "./parts";
import type { Device, DeviceMode, User } from "./types";

type DeviceId = Device["deviceId"];

const MODE_LABELS: Readonly<Record<DeviceMode, string>> = {
  personal: "Personal",
  shared: "Shared",
};

/** What one device's row is asking or choosing. */
type DeviceStep =
  | { readonly kind: "idle" }
  | { readonly kind: "switching" }
  | { readonly kind: "removing" }
  | { readonly kind: "resetting"; readonly userId: UserId | "" };

/** The open device and its step; one device at a time. */
export interface DeviceFocus {
  readonly deviceId: DeviceId;
  readonly step: Exclude<DeviceStep, { readonly kind: "idle" }>;
}

/** Devices: every registered device, made shared or personal, removed, or a code reset on it. */
export function DevicesScreen() {
  const platform = usePlatform();
  const registry = platform.core.devices.registry;
  const devices = usePages(registry.list, (paginationOpts) => ({ paginationOpts }));

  const users = useAllPages(platform.core.accounts.users.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const actions = useActions<"mode" | "remove" | "reset">();
  const [focus, setFocus] = useState<DeviceFocus | null>(null);

  /** Runs a device command and closes the row's step once it succeeds. */
  const settle = async (
    name: "mode" | "remove" | "reset",
    call: () => Promise<null>,
    success: string,
  ): Promise<void> => {
    if ((await actions.run(name, call, success)) !== undefined) setFocus(null);
  };

  return (
    <DevicesView
      devices={devices}
      users={users.status === "ready" ? users.rows : []}
      focus={focus}
      running={actions.running}
      onFocus={setFocus}
      onMode={(device) => {
        const mode: DeviceMode = device.mode === "shared" ? "personal" : "shared";

        void settle(
          "mode",
          () => registry.setMode({ deviceId: device.deviceId, mode }),
          `${device.name} is ${mode} now`,
        );
      }}
      onRemove={(device) =>
        void settle(
          "remove",
          () => registry.remove({ deviceId: device.deviceId }),
          `Removed ${device.name}`,
        )
      }
      onReset={(device, userId) =>
        void settle(
          "reset",
          () => platform.core.devices.unlockCodes.reset({ deviceId: device.deviceId, userId }),
          `Unlock code works again on ${device.name}`,
        )
      }
    />
  );
}

/** The device list; the focused device shows its confirmation or its unlock-code reset. */
export function DevicesView({
  devices,
  users,
  focus,
  running,
  onFocus,
  onMode,
  onRemove,
  onReset,
}: {
  readonly devices: Paged<Device>;
  readonly users: ReadonlyArray<User>;
  readonly focus: DeviceFocus | null;
  readonly running: "mode" | "remove" | "reset" | null;
  readonly onFocus: (focus: DeviceFocus | null) => void;
  readonly onMode: (device: Device) => void;
  readonly onRemove: (device: Device) => void;
  readonly onReset: (device: Device, userId: UserId) => void;
}) {
  const busy = running !== null;
  const people = users.filter((user) => user.role !== "guest");

  return (
    <>
      <PageHeader title="Devices" />
      <PagedList
        label="Devices"
        list={devices}
        empty="No device has registered yet."
        rowKey={(device) => device.deviceId}
      >
        {(device) => {
          const step: DeviceStep =
            focus?.deviceId === device.deviceId ? focus.step : { kind: "idle" };

          const open = (next: DeviceFocus["step"]) =>
            onFocus({ deviceId: device.deviceId, step: next });

          const cancel = (
            <Button variant="ghost" size="xs" onClick={() => onFocus(null)}>
              Cancel
            </Button>
          );

          return (
            <ItemRow
              title={device.name}
              facts={MODE_LABELS[device.mode]}
              actions={
                step.kind === "idle" ? (
                  <>
                    <Button
                      variant="raised"
                      size="row"
                      disabled={busy}
                      onClick={() => open({ kind: "switching" })}
                    >
                      {device.mode === "shared" ? "Make personal" : "Make shared"}
                    </Button>
                    {device.mode === "shared" ? (
                      <Button
                        variant="raised"
                        size="row"
                        disabled={busy}
                        onClick={() => open({ kind: "resetting", userId: "" })}
                      >
                        Reset an unlock code
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="row"
                      disabled={busy}
                      onClick={() => open({ kind: "removing" })}
                    >
                      Remove
                    </Button>
                  </>
                ) : null
              }
            >
              {step.kind === "switching" ? (
                <Notice
                  action={
                    <div className="flex gap-2">
                      {cancel}
                      <Button size="xs" disabled={busy} onClick={() => onMode(device)}>
                        {device.mode === "shared" ? "Make personal" : "Make shared"}
                      </Button>
                    </div>
                  }
                >
                  {`Everyone on ${device.name} is signed out.`}
                </Notice>
              ) : null}
              {step.kind === "removing" ? (
                <Notice
                  action={
                    <div className="flex gap-2">
                      {cancel}
                      <Button
                        variant="destructive"
                        size="xs"
                        disabled={busy}
                        onClick={() => onRemove(device)}
                      >
                        Remove
                      </Button>
                    </div>
                  }
                >
                  {`${device.name} is forgotten and everyone on it is signed out.`}
                </Notice>
              ) : null}
              {step.kind === "resetting" ? (
                <div className="flex flex-wrap items-end gap-2">
                  <SelectField
                    label="Whose unlock code"
                    value={step.userId}
                    options={[
                      { value: "", label: "Choose a person" },
                      ...people.map((user) => ({ value: user.userId, label: user.username })),
                    ]}
                    onChange={(userId) => open({ kind: "resetting", userId })}
                    className="min-w-0 flex-1 basis-48"
                  />
                  {cancel}
                  <Button
                    size="xs"
                    disabled={busy || step.userId === ""}
                    onClick={() => {
                      if (step.userId !== "") onReset(device, step.userId);
                    }}
                  >
                    Reset
                  </Button>
                </div>
              ) : null}
            </ItemRow>
          );
        }}
      </PagedList>
    </>
  );
}
