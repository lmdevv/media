import { Forbidden, NotFound, Unauthenticated } from "@media/contracts/errors";
import type { QueryState } from "@media/sdk/react";
import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import type {
  Me,
  PickerView,
  ServerInfo,
  SharedPicker,
  SharedTile,
  UserId,
} from "./platform-types";
import { deviceUnknown, screenOf } from "./screen";
import type { ScreenInputs } from "./screen";

const userId = Brand.nominal<UserId>();

const ada = userId("user-ada");

const kid = userId("user-kid");

const loading = { status: "loading" } as const;

const success = <A>(data: A): QueryState<A> => ({ status: "success", data });

const retry = (): void => undefined;

const meAs = (scopes: Me["scopes"], kind: Me["kind"] = "password"): Me => ({
  userId: ada,
  username: "ada",
  role: "member",
  sessionId: Brand.nominal<Me["sessionId"]>()("session-1"),
  kind,
  scopes,
});

const deviceId = Brand.nominal<SharedPicker["deviceId"]>()("device-1");

const tile = (overrides: Partial<SharedTile>): SharedTile => ({
  userId: ada,
  username: "ada",
  kid: false,
  code: "none",
  lock: { state: "open" },
  ...overrides,
});

const shared = (tiles: ReadonlyArray<SharedTile>): SharedPicker => ({
  deviceId,
  name: "Living room TV",
  mode: "shared",
  holder: null,
  tiles: [...tiles],
  approval: null,
});

const base: ScreenInputs = {
  intent: { kind: "picker" },
  server: success<ServerInfo>({ name: "[media]", version: "0.2.0", hasOwner: true }),
  status: "signedOut",
  me: loading,
  device: null,
  picker: loading,
  held: new Set(),
  slotHeld: true,
};

const inputs = (overrides: Partial<ScreenInputs>): ScreenInputs => ({ ...base, ...overrides });

describe("which screen shows", () => {
  it("asks for the first owner on a server without one", () => {
    const server = success<ServerInfo>({ name: "[media]", version: "0.2.0", hasOwner: false });

    expect(screenOf(inputs({ server }))).toStrictEqual({ kind: "setUpOwner" });
  });

  it("shows public pages before the server answers", () => {
    expect(
      screenOf(inputs({ intent: { kind: "page", need: "public" }, server: loading })),
    ).toStrictEqual({ kind: "page", me: null });
  });

  it("asks a browser with no one on it to sign in", () => {
    expect(screenOf(inputs({}))).toStrictEqual({ kind: "signIn", adding: false });
  });

  it("keeps showing sign-in until a new sign-in has registered this browser", () => {
    expect(
      screenOf(inputs({ status: "signedIn", me: success(meAs(["account"])), slotHeld: false })),
    ).toStrictEqual({ kind: "signIn", adding: false });
  });

  it("shows a personal device's picker with the people this browser holds", () => {
    const picker = success<PickerView>({
      deviceId,
      name: "Firefox on Linux",
      mode: "personal",
      tiles: [
        { userId: ada, username: "ada" },
        { userId: kid, username: "kid" },
      ],
    });

    expect(screenOf(inputs({ device: "dv_1.x", picker, held: new Set([ada]) }))).toStrictEqual({
      kind: "personalPicker",
      tiles: [
        { userId: ada, username: "ada", here: true },
        { userId: kid, username: "kid", here: false },
      ],
    });
  });

  it("shows a signed-in person the picker at /", () => {
    const picker = success<PickerView>({
      deviceId,
      name: "Firefox on Linux",
      mode: "personal",
      tiles: [{ userId: ada, username: "ada" }],
    });

    expect(
      screenOf(
        inputs({
          status: "signedIn",
          me: success(meAs(["account"])),
          device: "dv_1.x",
          picker,
          held: new Set([ada]),
        }),
      ),
    ).toStrictEqual({
      kind: "personalPicker",
      tiles: [{ userId: ada, username: "ada", here: true }],
    });
  });

  it("shows a shared device's picker while its slot is empty", () => {
    const view = shared([tile({})]);

    expect(screenOf(inputs({ device: "dv_1.x", picker: success(view) }))).toStrictEqual({
      kind: "sharedPicker",
      picker: view,
    });
  });

  it("shows the lock screen of a locked tile, with the approval this device waits on", () => {
    const locked = tile({ lock: { state: "locked", because: ["kid-listed"], opensWith: "self" } });

    const view: SharedPicker = {
      ...shared([locked, tile({ userId: kid, username: "kid", kid: true })]),
      mode: "shared",
      approval: {
        approvalId:
          Brand.nominal<NonNullable<SharedPicker["approval"]>["approvalId"]>()("approval-1"),
        intent: "open",
        userId: ada,
        state: "pending",
        expiresAt: 0,
      },
    };

    expect(
      screenOf(
        inputs({ intent: { kind: "tile", userId: ada }, device: "dv", picker: success(view) }),
      ),
    ).toStrictEqual({ kind: "tileLock", picker: view, tile: locked, approval: view.approval });
  });

  it("shows the picker for a tile that is open, which opens from there", () => {
    const view = shared([tile({})]);

    expect(
      screenOf(
        inputs({ intent: { kind: "tile", userId: ada }, device: "dv", picker: success(view) }),
      ),
    ).toStrictEqual({ kind: "sharedPicker", picker: view });
  });

  it("keeps a tile session out of account pages and a member out of admin", () => {
    const tileSession = success(meAs(["movies:read", "movies:play"], "tile"));
    const member = success(meAs(["account", "movies:read"]));

    expect(
      screenOf(
        inputs({ intent: { kind: "page", need: "account" }, status: "signedIn", me: tileSession }),
      ),
    ).toMatchObject({ kind: "needsAccount" });
    expect(
      screenOf(inputs({ intent: { kind: "page", need: "admin" }, status: "signedIn", me: member })),
    ).toMatchObject({ kind: "needsAdmin" });
    expect(
      screenOf(
        inputs({ intent: { kind: "page", need: "anyone" }, status: "signedIn", me: tileSession }),
      ),
    ).toMatchObject({ kind: "page" });
  });

  it("signs someone else in on /add while another person is active", () => {
    expect(
      screenOf(
        inputs({ intent: { kind: "add" }, status: "signedIn", me: success(meAs(["account"])) }),
      ),
    ).toStrictEqual({ kind: "signIn", adding: true });
  });

  it("waits while a refused session is renewed or replaced", () => {
    const me: QueryState<Me> = {
      status: "error",
      error: new Unauthenticated({ message: "ended" }),
      retry,
    };

    expect(screenOf(inputs({ status: "signedIn", me }))).toStrictEqual({ kind: "loading" });
  });

  it("asks to try again when the server fails", () => {
    const server: QueryState<ServerInfo> = {
      status: "error",
      error: new Forbidden({ message: "down" }),
      retry,
    };

    expect(screenOf(inputs({ server }))).toStrictEqual({ kind: "unreachable", retry });
  });
});

describe("when this browser forgets its device", () => {
  it("forgets a device code the core no longer knows", () => {
    const picker: QueryState<PickerView> = {
      status: "error",
      error: new NotFound({ message: "No such device" }),
      retry,
    };

    expect(deviceUnknown(inputs({ device: "dv", picker }))).toBe(true);
  });

  it("keeps people the picker does not list yet, since another tab may have just added them", () => {
    const picker = success<PickerView>({
      deviceId,
      name: "Firefox on Linux",
      mode: "personal",
      tiles: [{ userId: ada, username: "ada" }],
    });

    expect(deviceUnknown(inputs({ device: "dv", picker, held: new Set([ada, kid]) }))).toBe(false);
  });
});
