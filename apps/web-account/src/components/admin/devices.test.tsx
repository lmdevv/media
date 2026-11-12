import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import type { UserId } from "@/session/platform-types";

import { DevicesView } from "./devices";
import type { DeviceFocus } from "./devices";
import type { Paged } from "@media/ui/lib/pages";
import { disabledButton, loaded, noop, textOf } from "./testing";
import type { Device, User } from "./types";

const deviceId = Brand.nominal<Device["deviceId"]>();

const userId = Brand.nominal<UserId>();

const tv: Device = { deviceId: deviceId("d1"), name: "Living room TV", mode: "shared" };

const phone: Device = { deviceId: deviceId("d2"), name: "Ada's phone", mode: "personal" };

const sam: User = { userId: userId("u1"), username: "sam", displayName: null, role: "member" };

const visitor: User = {
  userId: userId("u2"),
  username: "Visitor",
  displayName: null,
  role: "guest",
};

const devices = (list: Paged<Device>, focus: DeviceFocus | null = null) => (
  <DevicesView
    devices={list}
    users={[sam, visitor]}
    focus={focus}
    running={null}
    onFocus={noop}
    onMode={noop}
    onRemove={noop}
    onReset={noop}
  />
);

describe("DevicesView", () => {
  it("says when no device has registered", () => {
    expect(textOf(devices(loaded([])))).toContain("No device has registered yet.");
  });

  it("lists each device with its mode and the actions it allows", () => {
    const text = textOf(devices(loaded([tv, phone])));

    expect(text).toContain("Living room TV Shared Make personal Reset an unlock code Remove");
    expect(text).toContain("Ada's phone Personal Make shared Remove");
  });

  it("warns that changing the mode signs everyone out", () => {
    expect(
      textOf(devices(loaded([tv]), { deviceId: tv.deviceId, step: { kind: "switching" } })),
    ).toContain("Everyone on Living room TV is signed out. Cancel Make personal");
  });

  it("asks before removing", () => {
    expect(
      textOf(devices(loaded([phone]), { deviceId: phone.deviceId, step: { kind: "removing" } })),
    ).toContain("Ada's phone is forgotten and everyone on it is signed out.");
  });

  it("resets a person's unlock code once one is chosen, and never offers a guest", () => {
    const choosing = devices(loaded([tv]), {
      deviceId: tv.deviceId,
      step: { kind: "resetting", userId: "" },
    });

    expect(textOf(choosing)).toContain("Whose unlock code Choose a person sam Cancel Reset");
    expect(textOf(choosing)).not.toContain("Visitor");
    expect(disabledButton(choosing, "Reset")).toBe(true);

    const chosen = devices(loaded([tv]), {
      deviceId: tv.deviceId,
      step: { kind: "resetting", userId: sam.userId },
    });

    expect(disabledButton(chosen, "Reset")).toBe(false);
  });
});
