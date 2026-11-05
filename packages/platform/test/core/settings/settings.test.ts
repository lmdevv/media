import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import {
  deviceSettingDefaults,
  settingTable,
  userSettingDefaults,
} from "../../../commands/settings";
import type { SettingName } from "../../../commands/settings";
import { api } from "../../../convex/_generated/api";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { refusalOf } from "../../../convex/core/settings";
import type { Id } from "../../../convex/_generated/dataModel";
import { enroll, listings, member, openTile, sharedAdmin, sharedDevice } from "../../devices";
import type { Member } from "../../devices";
import { newestRows } from "../../rows";
import { refusal, signIn, signInAs } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

type Changes = FunctionArgs<typeof api.core.settings.set>;

type View = FunctionReturnType<typeof api.core.settings.get>;

const ADR_0019 = {
  user: [
    "subtitleLanguage",
    "audioLanguage",
    "subtitleStyle",
    "autoplay",
    "explicitFilter",
    "crossfade",
    "gapless",
  ],
  device: ["streamQuality", "downloadQuality", "volume"],
} as const;

const SAMPLES = {
  subtitleLanguage: { subtitleLanguage: "fr" },
  audioLanguage: { audioLanguage: "ja" },
  subtitleStyle: { subtitleStyle: { size: "large", color: "yellow", backdrop: "box" } },
  autoplay: { autoplay: false },
  explicitFilter: { explicitFilter: true },
  crossfade: { crossfade: 6 },
  gapless: { gapless: false },
  streamQuality: { streamQuality: "low" },
  downloadQuality: { downloadQuality: "high" },
  volume: { volume: 0.25 },
} as const satisfies { readonly [N in SettingName]: Required<Pick<Changes, N>> };

const names = Object.keys(settingTable).filter((name): name is SettingName => name in SAMPLES);

const scoped = (scope: "user" | "device"): ReadonlyArray<SettingName> =>
  names.filter((name) => settingTable[name].scope === scope);

const get = (client: ConvexHttpClient): Promise<View> => client.query(api.core.settings.get, {});

const set = (client: ConvexHttpClient, changes: Changes): Promise<View> =>
  client.mutation(api.core.settings.set, changes);

const flat = (view: View) => ({
  ...view.user,
  ...view.device,
});

interface TwoDevices {
  readonly person: Member;
  readonly phone: SignedIn & { readonly deviceId: Id<"devices"> };
  readonly laptop: SignedIn & { readonly deviceId: Id<"devices"> };
}

const onTwoDevices = async (label: string): Promise<TwoDevices> => {
  if (stack === undefined) throw new Error("no stack");

  const person = await member(stack, label);
  const phone = await signInAs(stack, person.person);
  const laptop = await signInAs(stack, person.person);
  const phoneDevice = await enroll(phone, "Phone");
  const laptopDevice = await enroll(laptop, "Laptop");

  return {
    person,
    phone: { ...phone, deviceId: phoneDevice.deviceId },
    laptop: { ...laptop, deviceId: laptopDevice.deviceId },
  };
};

const decodeRow = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ deviceId: Schema.String })),
);

const settingsRowsOf = (deviceId: Id<"devices">): ReadonlyArray<string> =>
  newestRows("deviceSettings").filter((line) => decodeRow(line).deviceId === deviceId);

const eventually = async (check: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;

  const poll = async (): Promise<boolean> => {
    if (check()) return true;

    if (Date.now() > deadline) return false;

    await new Promise((resolve) => setTimeout(resolve, 200));

    return poll();
  };

  return poll();
};

const untypedRefs = {
  get: makeFunctionReference<"query">("core/settings:get"),
  set: makeFunctionReference<"mutation">("core/settings:set"),
};

const listed = listings();

describe("the settings table", () => {
  it("marks every setting in ADR 0019 with its scope, once", () => {
    expect(scoped("user")).toEqual(ADR_0019.user);
    expect(scoped("device")).toEqual(ADR_0019.device);
    expect(names).toHaveLength(Object.keys(settingTable).length);
  });

  it("gives every setting a default its own check accepts", () => {
    const defaults = { ...userSettingDefaults, ...deviceSettingDefaults };

    expect(names.map((name) => refusalOf(name, defaults))).toEqual(names.map(() => null));
  });
});

describe.skipIf(stack === undefined)("settings", { timeout: 120_000 }, () => {
  afterAll(async () => {
    await listed.clear();
  });

  it("route every setting to the person or to the device", async () => {
    const { phone, laptop } = await onTwoDevices("every-setting");
    const before = flat(await get(laptop.client));

    await inOrder(names, async (name) => {
      const sample = SAMPLES[name];

      await set(phone.client, sample);

      const [onPhone, onLaptop] = await Promise.all([get(phone.client), get(laptop.client)]);

      expect(flat(onPhone), `${name} on the phone`).toMatchObject(sample);

      if (settingTable[name].scope === "user") {
        expect(flat(onLaptop), `${name} follows the person`).toMatchObject(sample);
      } else {
        expect(flat(onLaptop)[name], `${name} stays on the phone`).toEqual(before[name]);
      }
    });
  });

  it("show the subtitle language set on one device on another, and keep each volume", async () => {
    const { phone, laptop } = await onTwoDevices("you-see");

    await set(phone.client, { subtitleLanguage: "de", volume: 0.3 });
    await set(laptop.client, { volume: 0.8 });

    const [onPhone, onLaptop] = await Promise.all([get(phone.client), get(laptop.client)]);

    expect(onLaptop.user.subtitleLanguage).toBe("de");
    expect(onPhone.device?.volume).toBe(0.3);
    expect(onLaptop.device?.volume).toBe(0.8);
  });

  it("keep each person's own device settings on a shared device", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);
    const aiko = await listed.adult(await member(stack, "aiko"));
    const ben = await listed.adult(await member(stack, "ben"));
    const tv = await sharedDevice(stack, admin);

    const aikoOnTv = await openTile(stack, tv, aiko.userId);

    await set(aikoOnTv.client, { volume: 0.1, subtitleLanguage: "es" });

    const benOnTv = await openTile(stack, tv, ben.userId);
    const shownToBen = await get(benOnTv.client);

    expect(shownToBen.device?.volume).toBe(1);
    expect(shownToBen.user.subtitleLanguage).toBeNull();

    const aikoElsewhere = await get(aiko.signedIn.client);

    expect(aikoElsewhere.user.subtitleLanguage).toBe("es");
    expect(aikoElsewhere.device).toBeNull();
  });

  it("refuse a setting that does not exist and values out of range", async () => {
    const { phone } = await onTwoDevices("unknown");

    expect(await refusal(phone.client.mutation(untypedRefs.set, { brightness: 3 }))).toMatch(
      /^failed: .*brightness/su,
    );
    expect(await refusal(set(phone.client, {}))).toBe("invalid_args");
    expect(await refusal(set(phone.client, { volume: 1.5 }))).toBe("invalid_args");
    expect(await refusal(set(phone.client, { crossfade: 2.5 }))).toBe("invalid_args");
    expect(await refusal(set(phone.client, { subtitleLanguage: "eng" }))).toBe("invalid_args");
    expect(await refusal(set(phone.client, { subtitleLanguage: "fr", volume: -1 }))).toBe(
      "invalid_args",
    );
    expect((await get(phone.client)).user.subtitleLanguage).toBeNull();
  });

  it("show no one else's settings", async () => {
    const first = await onTwoDevices("owner-of-settings");
    const second = await onTwoDevices("someone-else");

    await set(first.phone.client, { subtitleLanguage: "it", volume: 0.5 });

    expect(
      await refusal(second.phone.client.query(untypedRefs.get, { userId: first.person.userId })),
    ).toMatch(/^failed: .*userId/su);

    const shown = await get(second.phone.client);

    expect(shown.user.subtitleLanguage).toBeNull();
    expect(shown.device?.volume).toBe(1);
  });

  it("forget a device's settings when it is removed", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);
    const { phone, laptop } = await onTwoDevices("removed");

    await set(phone.client, { volume: 0.2, streamQuality: "low", autoplay: false });
    await set(laptop.client, { volume: 0.7 });

    expect(settingsRowsOf(phone.deviceId)).toHaveLength(1);

    await admin.signedIn.client.mutation(api.core.devices.registry.remove, {
      deviceId: phone.deviceId,
    });

    expect(await eventually(() => settingsRowsOf(phone.deviceId).length === 0)).toBe(true);
    expect(await refusal(get(phone.client))).toBe("unauthenticated");

    const onLaptop = await get(laptop.client);

    expect(onLaptop.device?.volume).toBe(0.7);
    expect(onLaptop.user.autoplay).toBe(false);
  });

  it("let a session change only the settings its scopes reach", async () => {
    if (stack === undefined) return;

    const person = await member(stack, "scoped");

    const keyFor = async (scope: "movies:read" | "music:play"): Promise<ConvexHttpClient> => {
      const { key } = await person.signedIn.client.action(api.core.auth.apiKeys.create, {
        name: scope,
        scopes: [scope],
      });

      return (await signIn(stack, "apiKey", { key })).client;
    };

    const reader = await keyFor("movies:read");
    const speaker = await keyFor("music:play");

    expect((await get(reader)).device).toBeNull();
    expect(await refusal(set(reader, { autoplay: false }))).toBe("forbidden");
    expect(await refusal(set(reader, { crossfade: 2.5 }))).toBe("forbidden");
    expect((await set(speaker, { crossfade: 4 })).user.crossfade).toBe(4);
    expect(
      await refusal(set(speaker, { subtitleStyle: SAMPLES.subtitleStyle.subtitleStyle })),
    ).toBe("forbidden");
    expect(await refusal(set(speaker, { volume: 0.5 }))).toBe("conflict");
    expect(await refusal(set(speaker, { gapless: false, volume: 0.5 }))).toBe("conflict");
    expect((await get(person.signedIn.client)).user.gapless).toBe(true);
  });

  it("leave a kid's restrictions alone when the kid turns the explicit filter off", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);
    const kid = await member(stack, "kid");

    await admin.signedIn.client.mutation(api.core.restrictions.set, {
      userId: kid.userId,
      restrictions: {
        maxMovieAge: 7,
        hideUnrated: false,
        hideExplicitMusic: true,
        libraries: null,
      },
    });

    expect((await set(kid.signedIn.client, { explicitFilter: false })).user.explicitFilter).toBe(
      false,
    );
    expect(
      await kid.signedIn.client.query(api.core.restrictions.get, { userId: kid.userId }),
    ).toMatchObject({ hideExplicitMusic: true });
  });
});
