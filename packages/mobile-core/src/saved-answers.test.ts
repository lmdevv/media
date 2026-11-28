import { Brand } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { memoryKeychain } from "./keychain";
import type { Keychain } from "./keychain";
import { writeAppRecord, writePhoneAccount } from "./records";
import type { UserId } from "./records";
import { savedAnswers, savedAnswersFileName } from "./saved-answers";
import type { CacheFile } from "./saved-answers";
import { appConfigText } from "./testing/app-config";

const SERVER = "http://cinema.home";

const asUserId = Brand.nominal<UserId>();

/** This app's keychains, signed in last as `person`, on a phone whose shared record names `phone`. */
const keychains = (person: string | null, phone: { server: string; userId: string } | null) => {
  const own: Keychain = memoryKeychain();
  const shared: Keychain = memoryKeychain();

  if (person !== null) {
    writeAppRecord(own, SERVER, {
      device: null,
      person: { userId: asUserId(person), username: person },
      opened: true,
    });
  }

  if (phone !== null) {
    writePhoneAccount(shared, { ...phone, userId: asUserId(phone.userId), grant: "dg_1.secret" });
  }

  return { own, shared, server: SERVER };
};

const cacheFolder = () => {
  const files = new Map<string, string>();

  const cacheFile = (name: string): CacheFile => ({
    get exists() {
      return files.has(name);
    },
    text: async () => files.get(name) ?? "",
    write: async (text) => {
      files.set(name, text);
    },
    delete: () => {
      files.delete(name);
    },
  });

  return { files, cacheFile };
};

const options = (
  cacheFile: (name: string) => CacheFile,
  convexUrl: string,
  here = keychains("ada", { server: SERVER, userId: "ada" }),
) => ({
  cacheFile,
  convexUrl,
  release: "0.10.0",
  queries: ["movies.titles.home"],
  here,
});

const fileOf = (saved: ReturnType<typeof savedAnswers>) => {
  if (saved === undefined) throw new Error("Expected saved answers");

  return saved.file;
};

describe("savedAnswers", () => {
  it("names each server's file apart, in letters, digits, dots, dashes, and underscores", () => {
    fc.assert(
      fc.property(fc.webUrl(), fc.webUrl(), (a, b) => {
        expect(savedAnswersFileName(a)).toMatch(/^[\w.-]+$/u);
        expect(savedAnswersFileName(a) === savedAnswersFileName(b)).toBe(a === b);
      }),
    );
  });

  it("reads nothing before the first save, then the text saved, and nothing once removed", async () => {
    const { files, cacheFile } = cacheFolder();
    const file = fileOf(savedAnswers(options(cacheFile, "http://cinema.home/convex")));

    const before = await file.read();

    await file.write("saved");
    const saved = await file.read();

    await file.remove();
    await file.remove();

    expect({ before, saved, after: await file.read(), left: files.size }).toStrictEqual({
      before: null,
      saved: "saved",
      after: null,
      left: 0,
    });
  });

  it("keeps two servers' answers in two files", async () => {
    const { files, cacheFile } = cacheFolder();

    await fileOf(savedAnswers(options(cacheFile, "http://cinema.home/convex"))).write("home");
    await fileOf(savedAnswers(options(cacheFile, "http://cabin.home/convex"))).write("cabin");

    expect([...files.values()].toSorted()).toStrictEqual(["cabin", "home"]);
  });

  it("saves nothing and deletes the file once another person took the phone in a sibling app", async () => {
    const { files, cacheFile } = cacheFolder();

    await fileOf(savedAnswers(options(cacheFile, "http://cinema.home/convex"))).write("ada's");

    const taken = savedAnswers(
      options(
        cacheFile,
        "http://cinema.home/convex",
        keychains("ada", { server: SERVER, userId: "grace" }),
      ),
    );

    await Promise.resolve();

    expect({ taken, left: files.size }).toStrictEqual({ taken: undefined, left: 0 });
  });

  it.each([
    ["the phone names the same person", keychains("ada", { server: SERVER, userId: "ada" })],
    [
      "the phone names someone on another server",
      keychains("ada", { server: "http://cabin.home", userId: "grace" }),
    ],
    ["the phone keeps no shared record", keychains("ada", null)],
    ["this app never signed in", keychains(null, { server: SERVER, userId: "grace" })],
  ])("keeps saving when %s", (_, here) => {
    const { cacheFile } = cacheFolder();

    expect(savedAnswers(options(cacheFile, "http://cinema.home/convex", here))).toBeDefined();
  });

  it.each(["movies", "music"])(
    "relies on the %s app's default file protection, with no data-protection entitlement",
    (app) => {
      expect(appConfigText(app)).not.toContain("com.apple.developer.default-data-protection");
    },
  );
});
