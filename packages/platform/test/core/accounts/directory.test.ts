import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { member } from "../../devices";
import type { Member } from "../../devices";
import { guestOf } from "../../guests";
import { movie, seedLibrary } from "../../probe";
import type { Session } from "../../probe";
import { refusal, signIn, unique } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

/** Rows a page asks for: the whole household on a page or two. */
const PAGE_ROWS = 200;

const readPage = (signedIn: SignedIn, cursor: string | null) =>
  signedIn.client.query(api.core.accounts.directory.list, {
    paginationOpts: { numItems: PAGE_ROWS, cursor },
  });

type Row = Awaited<ReturnType<typeof readPage>>["page"][number];

/** Every row of the directory as `signedIn` sees it, page after page. */
const everyone = async (
  signedIn: SignedIn,
  cursor: string | null = null,
  seen: ReadonlyArray<Row> = [],
): Promise<ReadonlyArray<Row>> => {
  const page = await readPage(signedIn, cursor);
  const rows = [...seen, ...page.page];

  return page.isDone ? rows : everyone(signedIn, page.continueCursor, rows);
};

const rowOf = (rows: ReadonlyArray<Row>, userId: Id<"users">): Row | undefined =>
  rows.find((row) => row.userId === userId);

const guestOn = async (maker: Member): Promise<Session> => {
  if (stack === undefined) throw new Error("no stack");

  const films = await seedLibrary(stack, maker, {
    name: `films-${unique()}`,
    kind: "movies",
    items: [movie("shared.mkv", 0)],
  });

  const [titleId] = films.itemIds;

  if (titleId === undefined) throw new Error("seeded no title");

  return guestOf(stack, maker, { domain: "movies", ref: { type: "title", id: titleId } }, "Sam");
};

describe.skipIf(stack === undefined)("the people directory", { timeout: 120_000 }, () => {
  it("gives a member everyone else by id, name, and role, as old music's people.directory did", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko");
    const mateo = await member(stack, "mateo");
    const admin = await member(stack, "admin", "admin");

    await mateo.signedIn.client.mutation(api.core.accounts.me.setDisplayName, {
      displayName: "Mateo",
    });

    const rows = await everyone(aiko.signedIn);

    expect(rowOf(rows, mateo.userId)).toStrictEqual({
      userId: mateo.userId,
      name: "Mateo",
      role: "member",
    });
    expect(rowOf(rows, admin.userId)).toStrictEqual({
      userId: admin.userId,
      name: admin.username,
      role: "admin",
    });
    expect(rowOf(rows, aiko.userId)).toBeUndefined();
    expect(new Set(rows.map((row) => row.userId)).size).toBe(rows.length);
  });

  it("leaves out the guests a link let in, and refuses them and keys that only play", async () => {
    if (stack === undefined) return;
    const maker = await member(stack, "maker", "admin");
    const guest = await guestOn(maker);

    expect(rowOf(await everyone(maker.signedIn), guest.userId)).toBeUndefined();
    expect(await refusal(readPage(guest.signedIn, null))).toBe("forbidden");

    const { key } = await maker.signedIn.client.action(api.core.auth.apiKeys.create, {
      name: "player",
      scopes: ["music:play"],
    });

    expect(await refusal(readPage(await signIn(stack, "apiKey", { key }), null))).toBe("forbidden");
  });
});
