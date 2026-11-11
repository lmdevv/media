import { describe, expect, it } from "vitest";

import { transform } from "./movies-codemod";

const lines = (...source: ReadonlyArray<string>): string => `${source.join("\n")}\n`;

describe("movies codemod", () => {
  it("turns a profile query into a platform query in its component", () => {
    const before = lines(
      'import type { ProfileId } from "@media/contracts/ids";',
      'import type { TitleCard } from "@media/contracts/models/catalog";',
      'import { useCommandQuery } from "@media/sdk/react";',
      "",
      'import { useActiveProfile } from "@/session/guards";',
      "",
      "export function Row({",
      "  title,",
      "  profileId,",
      "}: {",
      "  readonly title: TitleCard;",
      "  readonly profileId: ProfileId;",
      "}) {",
      '  const detail = useCommandQuery("titles.get", { profileId, titleId: title.id });',
      "",
      "  return null;",
      "}",
      "",
      "function Page() {",
      "  const { profile } = useActiveProfile();",
      '  const home = useCommandQuery("titles.home", { profileId: profile.id });',
      "",
      "  return <Row title={home} profileId={profile.id} />;",
      "}",
    );

    expect(transform(before)).toEqual({
      code: lines(
        'import type { TitleCard } from "@/lib/catalog";',
        'import { usePlatform, usePlatformQuery } from "@media/sdk/react";',
        "",
        "",
        "export function Row({",
        "  title,",
        "}: {",
        "  readonly title: TitleCard;",
        "}) {",
        "  const platform = usePlatform();",
        "  const detail = usePlatformQuery(platform.movies.titles.get, { titleId: title.id });",
        "",
        "  return null;",
        "}",
        "",
        "function Page() {",
        "  const platform = usePlatform();",
        "  const home = usePlatformQuery(platform.movies.titles.home);",
        "",
        "  return <Row title={home} />;",
        "}",
      ),
      unmapped: [],
    });
  });

  it("binds a command to its platform method and drops the profile from its calls", () => {
    const before = lines(
      'import { useCommand } from "@media/sdk/react";',
      "",
      "export const useToggle = (profileId: ProfileId, titleId: TitleId) => {",
      '  const add = useCommand("myList.add");',
      "",
      "  return useCallback(() => add({ profileId, titleId }), [add, profileId, titleId]);",
      "};",
    );

    expect(transform(before).code).toBe(
      lines(
        'import { usePlatform } from "@media/sdk/react";',
        "",
        "export const useToggle = (titleId: TitleId) => {",
        "  const platform = usePlatform();",
        "  const add = platform.movies.myList.add;",
        "",
        "  return useCallback(() => add({ titleId }), [add, titleId]);",
        "};",
      ),
    );
  });

  it("leaves a command the core lacks in place, imported, and reports it", () => {
    const before = lines(
      'import { useCommand } from "@media/sdk/react";',
      "",
      "export const useCancel = () => {",
      '  const cancel = useCommand("jobs.cancel");',
      "",
      "  return cancel;",
      "};",
    );

    expect(transform(before)).toEqual({ code: before, unmapped: ["line 4: jobs.cancel"] });
  });

  it("passes skipped arguments through orSkip", () => {
    const before = lines(
      'import { useCommandQuery } from "@media/sdk/react";',
      "",
      'import { artworkUrl } from "@/lib/artwork";',
      "",
      "function Search({ query }: { readonly query: string }) {",
      '  const found = useCommandQuery("titles.search", query === "" ? "skip" : { query });',
      "",
      "  return artworkUrl(found, query);",
      "}",
    );

    expect(transform(before).code).toBe(
      lines(
        'import { usePlatform, usePlatformQuery } from "@media/sdk/react";',
        "",
        'import { orSkip } from "@/lib/query-state";',
        'import { artworkUrl } from "@/lib/artwork";',
        "",
        "function Search({ query }: { readonly query: string }) {",
        "  const platform = usePlatform();",
        '  const found = usePlatformQuery(platform.movies.titles.search, ...orSkip(query === "" ? null : { query }));',
        "",
        "  return artworkUrl(found, query);",
        "}",
      ),
    );
  });

  it("brands route params with the catalog in place of the old ID schemas", () => {
    const before = lines(
      'import { TitleId } from "@media/contracts/ids";',
      'import { Schema } from "effect";',
      "",
      'import { describeFailure } from "@/lib/failure";',
      'import { useScopes } from "@/session/viewer";',
      "",
      "const decodeTitleId = Schema.decodeSync(TitleId);",
      "",
      "const parse = (raw: { readonly titleId: string }) => decodeTitleId(raw.titleId);",
      'const canEdit = (scopes: ReadonlySet<string>) => scopes.has("manage");',
    );

    expect(transform(before).code).toBe(
      lines(
        'import { describeFailure } from "@media/ui/lib/failure";',
        'import { asTitleId } from "@/lib/catalog";',
        'import { useScopes } from "@/session/session";',
        "",
        "const parse = (raw: { readonly titleId: string }) => asTitleId(raw.titleId);",
        'const canEdit = (scopes: ReadonlySet<string>) => scopes.has("movies:edit");',
      ),
    );
  });

  it("changes nothing the second time", () => {
    const before = lines(
      'import { useCommand, useCommandQuery } from "@media/sdk/react";',
      "",
      "function Person({ profileId, personId }: Props) {",
      '  const person = useCommandQuery("people.get", { profileId, personId });',
      '  const request = useCommand("people.requestDetails");',
      "",
      "  return [person, request];",
      "}",
    );

    const once = transform(before).code;

    expect(transform(once).code).toBe(once);
  });
});
