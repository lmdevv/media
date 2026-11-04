import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import { movie, openProbe, seedProbes, sessionOf, song } from "../../probe";
import { createPerson, refusal, signIn, signInAs } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

describe.skipIf(stack === undefined)("domain scopes", { timeout: 120_000 }, () => {
  it("let a music:play key play music it may see, and nothing else", async () => {
    if (stack === undefined) return;
    const person = await signInAs(stack, await createPerson(stack, "listener"));
    const owner = await sessionOf(person);
    const [film, track] = await seedProbes(stack, owner, [movie("film", 0), song("track", false)]);

    if (film === undefined || track === undefined) throw new Error("seed made no probes");

    const { key } = await person.client.action(api.core.auth.apiKeys.create, {
      name: "speaker",
      scopes: ["music:play"],
    });

    const speaker = await sessionOf(await signIn(stack, "apiKey", { key }));

    expect(await speaker.signedIn.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      kind: "apiKey",
      scopes: ["music:play"],
    });
    expect(await refusal(openProbe(stack, speaker, film, "play", "movies:play"))).toBe("forbidden");
    expect(await refusal(openProbe(stack, speaker, film, "play"))).toBe("forbidden");
    expect(await openProbe(stack, speaker, track, "play", "music:play")).toMatchObject({
      probeId: track,
      level: "manage",
    });
    expect(await refusal(openProbe(stack, speaker, track, "view", "music:read"))).toBe("forbidden");
    expect(await refusal(openProbe(stack, speaker, track, "view"))).toBe("forbidden");
    expect(await openProbe(stack, owner, film, "view", "movies:read")).toMatchObject({
      probeId: film,
    });
  });

  it("keep a key from holding a scope its role lacks", async () => {
    if (stack === undefined) return;
    const member = await signInAs(stack, await createPerson(stack));

    expect(
      await refusal(
        member.client.action(api.core.auth.apiKeys.create, {
          name: "too much",
          scopes: ["music:play", "admin"],
        }),
      ),
    ).toBe("forbidden");
  });
});
