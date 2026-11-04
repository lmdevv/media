import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TitleId } from "@media/contracts/ids";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { NO_STACK, ownedStack, signInOwner, useSession } from "../admin/session";
import type { Client } from "../admin/session";
import { drawPoster, encodeClip } from "../stack/fixture-library";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import type { StackEnv } from "../stack/stack-env";

const stack = await ownedStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

const SETUP_TIMEOUT_MS = 180_000;

const SCAN_TIMEOUT_MS = 60_000;

const run = Date.now().toString(36);

const mod = process.platform === "darwin" ? "Meta" : "Control";

const withoutProvider = (env: StackEnv): StackEnv => ({
  ...env,
  mediaEnv: Object.fromEntries(
    Object.entries(env.mediaEnv).filter(([name]) => name !== "TMDB_API_KEY"),
  ),
});

const ALIEN = `<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>Alien Fixture</title>
  <year>1979</year>
  <premiered>1979-05-25</premiered>
  <plot>The crew of a towing ship answers a distress call.</plot>
  <runtime>117</runtime>
  <mpaa>R</mpaa>
  <ratings>
    <rating name="imdb" max="10" default="true"><value>8.5</value><votes>950000</votes></rating>
    <rating name="tomatometerallcritics" max="100"><value>93</value></rating>
    <rating name="metacritic" max="100"><value>89</value></rating>
    <rating name="themoviedb" max="10"><value>8.1</value></rating>
  </ratings>
  <genre>Horror</genre>
  <genre>Science Fiction</genre>
  <studio>Brandywine Fixture</studio>
  <country>United Kingdom</country>
  <tag>space</tag>
  <set tmdbcolid="8091"><name>Alien Fixture Collection</name><overview>Four films about the creature.</overview></set>
  <trailer>plugin://plugin.video.youtube/?action=play_video&amp;videoid=LjLamj-b0I8</trailer>
  <director>Ridley Scott</director>
  <credits>Dan O'Bannon</credits>
  <actor><name>Sigourney Weaver</name><role>Ripley</role><order>0</order></actor>
  <actor><name>Tom Skerritt</name><role>Dallas</role><order>1</order></actor>
  <uniqueid type="imdb">tt0078748</uniqueid>
  <uniqueid type="tmdb" default="true">348</uniqueid>
</movie>
`;

const ALIENS = `<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>Aliens Fixture</title>
  <year>1986</year>
  <plot>Ripley returns to the moon where her crew found the creature.</plot>
  <mpaa>R</mpaa>
  <genre>Action</genre>
  <genre>Science Fiction</genre>
  <set tmdbcolid="8091"><name>Alien Fixture Collection</name></set>
  <director>James Cameron</director>
  <actor><name>Sigourney Weaver</name><role>Ellen Ripley</role><order>0</order></actor>
  <uniqueid type="tmdb" default="true">679</uniqueid>
</movie>
`;

const MUSICAL = `<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>Singing Fixture</title>
  <year>1952</year>
  <mpaa>G</mpaa>
  <genre>Musical</genre>
  <actor><name>Gene Fixture</name><role>Don</role></actor>
</movie>
`;

const SERIES = `<?xml version="1.0" encoding="UTF-8"?>
<tvshow>
  <title>Fixture Series</title>
  <year>2020</year>
  <mpaa>TV-14</mpaa>
  <status>Ended</status>
  <studio>Fixture Network</studio>
  <genre>Drama</genre>
  <actor><name>Regular Fixture</name><role>Lead</role></actor>
</tvshow>
`;

const PILOT = `<?xml version="1.0" encoding="UTF-8"?>
<episodedetails>
  <title>Pilot</title>
  <season>1</season>
  <episode>1</episode>
  <aired>2020-03-31</aired>
  <plot>It begins.</plot>
  <ratings><rating name="imdb" max="10"><value>8.4</value></rating></ratings>
  <director>Pilot Director</director>
  <actor><name>Gus Guest</name><role>Visitor</role></actor>
</episodedetails>
`;

let workspace = "";

let media: MediaService | undefined;

let client: Client | undefined;

const titles = new Map<string, TitleId>();

const titleId = (name: string): TitleId => {
  const id = titles.get(name);

  if (id === undefined) throw new Error(`${name} was not scanned`);

  return id;
};

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await mkdtemp(join(tmpdir(), "movies-web-metadata-"));

  const library = join(workspace, `Metadata ${run}`);
  const alien = join(library, "Alien Fixture (1979)");
  const aliens = join(library, "Aliens Fixture (1986)");
  const musical = join(library, "Singing Fixture (1952)");
  const series = join(library, "Fixture Series (2020)");

  await Promise.all(
    [alien, aliens, musical, join(alien, ".actors"), join(series, "Season 01")].map((folder) =>
      mkdir(folder, { recursive: true }),
    ),
  );

  await Promise.all([
    encodeClip(join(alien, "Alien Fixture (1979).mkv")),
    encodeClip(join(aliens, "Aliens Fixture (1986).mkv")),
    encodeClip(join(musical, "Singing Fixture (1952).mkv")),
    encodeClip(join(series, "Season 01", "Fixture Series - S01E01.mkv")),
    writeFile(join(alien, "movie.nfo"), ALIEN),
    writeFile(join(aliens, "movie.nfo"), ALIENS),
    writeFile(join(musical, "movie.nfo"), MUSICAL),
    writeFile(join(series, "tvshow.nfo"), SERIES),
    writeFile(join(series, "Season 01", "Fixture Series - S01E01.nfo"), PILOT),
    drawPoster(browser, "Alien", join(alien, "poster.jpg")),
    drawPoster(browser, "Sigourney", join(alien, ".actors", "Sigourney_Weaver.jpg")),
  ]);

  buildMediaService();
  media = await startMediaService(withoutProvider(stack), [workspace]);
  client = await signInOwner(stack);

  const { sdk } = client;

  await sdk.mutate("libraries.create", {
    name: `Metadata ${run}`,
    kind: "mixed",
    roots: [library],
  });

  const profile = (await sdk.query("profiles.list", {})).find((each) => !each.kids);

  if (profile === undefined) throw new Error("The owner has no profile");

  const names = ["Alien Fixture", "Aliens Fixture", "Singing Fixture", "Fixture Series"];

  await expect
    .poll(
      async () => {
        const found = await sdk.query("titles.search", {
          profileId: profile.id,
          query: "Fixture",
          limit: 50,
        });

        for (const title of found) if (names.includes(title.name)) titles.set(title.name, title.id);

        return names.every((name) => titles.has(name));
      },
      { timeout: SCAN_TIMEOUT_MS },
    )
    .toBe(true);
});

test.afterAll(async () => {
  await client?.sdk.dispose();
  await media?.stop();

  if (workspace !== "") await rm(workspace, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  if (client !== undefined) await useSession(page, client);
});

const capture = async (page: Page, name: string, fullPage = false): Promise<void> => {
  const folder = process.env["E2E_SCREENSHOTS"];

  if (folder === undefined || folder === "") return;

  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: /TanStack Router/u }).evaluateAll((buttons) => {
    for (const button of buttons) {
      if (button instanceof HTMLElement) button.style.visibility = "hidden";
    }
  });
  await page.screenshot({ path: `${folder}/${name}.png`, fullPage });
};

const openTitle = async (page: Page, name: string): Promise<void> => {
  await page.goto(`/title/${titleId(name)}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(name, { ignoreCase: true });
};

test("a title page shows scores, credits, studio, links, the trailer, its collection, and more like this", async ({
  page,
}) => {
  await openTitle(page, "Alien Fixture");

  const ratings = page.getByRole("list", { name: "Ratings" });

  await expect(ratings.getByLabel("IMDb 8.5")).toBeVisible();
  await expect(ratings.getByLabel("Rotten Tomatoes 93%")).toBeVisible();
  await expect(ratings.getByLabel("Metacritic 89")).toBeVisible();
  await expect(ratings.getByLabel("TMDB 8.1")).toBeVisible();

  await expect(page.getByText("Directed by")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ridley Scott" }).first()).toBeVisible();
  await expect(page.getByText("Brandywine Fixture")).toBeVisible();
  await expect(page.getByText("May 25, 1979")).toBeVisible();
  await expect(page.getByRole("link", { name: "Horror" })).toHaveAttribute("href", "/genre/Horror");
  await expect(page.getByRole("link", { name: "IMDb" })).toHaveAttribute(
    "href",
    "https://www.imdb.com/title/tt0078748/",
  );
  await expect(page.getByRole("link", { name: "TMDB" })).toHaveAttribute(
    "href",
    "https://www.themoviedb.org/movie/348",
  );

  const cast = page.getByRole("region", { name: "Cast & crew" });

  await expect(cast.getByRole("link", { name: /Sigourney Weaver/u })).toHaveAccessibleName(
    "Sigourney Weaver Ripley",
  );
  await expect(cast.getByRole("link", { name: /Tom Skerritt/u })).toHaveAccessibleName(
    "Tom Skerritt Dallas",
  );

  const avatar = cast.getByRole("link", { name: /Tom Skerritt/u }).locator("[data-slot=avatar]");

  const [circle, letter] = await Promise.all([
    avatar.boundingBox(),
    avatar.getByText("T", { exact: true }).boundingBox(),
  ]);

  if (circle === null || letter === null) throw new Error("The avatar is not drawn");

  expect(Math.abs(letter.x + letter.width / 2 - (circle.x + circle.width / 2))).toBeLessThan(2);
  expect(Math.abs(letter.y + letter.height / 2 - (circle.y + circle.height / 2))).toBeLessThan(2);
  await expect(cast.getByRole("link", { name: /Ridley Scott/u })).toContainText("Director");

  await capture(page, "title-metadata", true);
  await page.getByRole("button", { name: "Trailer" }).click();

  const trailer = page.getByRole("dialog");

  await expect(trailer.locator("iframe")).toHaveAttribute(
    "src",
    /^https:\/\/www\.youtube-nocookie\.com\/embed\/LjLamj-b0I8\?/u,
  );
  await trailer.getByRole("button", { name: "Close" }).click();
  await expect(trailer).toBeHidden();

  const collection = page.getByRole("region", { name: "Part of Alien Fixture Collection" });

  await expect(collection.getByRole("link", { name: /Aliens Fixture/u })).toBeVisible();

  const similar = page.getByRole("region", { name: "More like this" });

  await expect(similar.getByRole("link", { name: /Aliens Fixture/u })).toBeVisible();
});

test("a person page shows their photo, life, links, and titles in the library", async ({
  page,
}) => {
  await openTitle(page, "Alien Fixture");
  await page
    .getByRole("region", { name: "Cast & crew" })
    .getByRole("link", { name: /Sigourney Weaver/u })
    .click();

  await expect(page).toHaveURL(/\/person\//u);
  await expect(page.getByRole("heading", { level: 1, name: "Sigourney Weaver" })).toBeVisible();

  await expect(page.getByRole("img", { name: "Sigourney Weaver" })).toHaveAttribute(
    "style",
    /artwork/u,
  );

  await capture(page, "person");

  const library = page.getByRole("region", { name: "In your library" });

  await expect(library.getByRole("link", { name: /Alien Fixture/u })).toContainText("as Ripley");
  await expect(library.getByRole("link", { name: /Aliens Fixture/u })).toContainText(
    "as Ellen Ripley",
  );
});

test("a person without a photo shows their letter in place of one", async ({ page }) => {
  await openTitle(page, "Alien Fixture");
  await page
    .getByRole("region", { name: "Cast & crew" })
    .getByRole("link", { name: /Tom Skerritt/u })
    .click();

  await expect(page.getByRole("heading", { level: 1, name: "Tom Skerritt" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Tom Skerritt" })).toHaveCount(0);
  await expect(page.locator("main").getByText("T", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "In your library" }).getByRole("link", {
      name: /Alien Fixture/u,
    }),
  ).toContainText("as Dallas");
  await capture(page, "person-without-photo");
});

test("genre pages and the grid's year and score filters narrow titles on the server", async ({
  page,
}) => {
  await page.goto("/genre/Science%20Fiction");
  await expect(page.getByRole("heading", { level: 1, name: "Science Fiction" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Alien Fixture/u })).toBeVisible();
  await expect(page.getByRole("link", { name: /Aliens Fixture/u })).toBeVisible();
  await expect(page.getByRole("link", { name: /Singing Fixture/u })).toBeHidden();

  await page.getByRole("button", { name: "Year" }).click();
  await page.getByRole("menuitemradio", { name: "1980s" }).click();
  await expect(page.getByRole("link", { name: /Aliens Fixture/u })).toBeVisible();
  await expect(page.getByRole("link", { name: /Alien Fixture/u })).toBeHidden();

  await page.goto("/genre/Musical");
  await expect(page.getByRole("link", { name: /Singing Fixture/u })).toBeVisible();
  await expect(page.getByRole("link", { name: /Alien Fixture/u })).toBeHidden();

  await page.goto("/movies");
  await page.getByRole("button", { name: "Science Fiction", exact: true }).click();
  await expect(page.getByRole("link", { name: /Aliens Fixture/u })).toBeVisible();
  await expect(page.getByRole("link", { name: /Singing Fixture/u })).toBeHidden();

  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: "Score" }).click();
  await page.getByRole("menuitemradio", { name: "8+" }).click();
  await expect(page.getByRole("link", { name: /Alien Fixture/u })).toBeVisible();
  await capture(page, "movies-filtered");
  await expect(page.getByRole("link", { name: /Singing Fixture/u })).toBeHidden();
});

test("collections have a page, a grid, and a row on Home", async ({ page }) => {
  await page.goto("/");

  const row = page.getByRole("region", { name: "Collections" });

  await expect(row.getByRole("link", { name: /Alien Fixture Collection/u })).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await capture(page, "home-collections");

  await page.goto("/collections");
  await expect(page.getByRole("link", { name: /Alien Fixture Collection/u })).toContainText(
    "2 titles",
  );
  await page.getByRole("link", { name: /Alien Fixture Collection/u }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: "Alien Fixture Collection" }),
  ).toBeVisible();
  await expect(page.getByText("Four films about the creature.")).toBeVisible();
  await capture(page, "collection");
  await expect(page.getByRole("link", { name: /Alien Fixture/u }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Aliens Fixture/u })).toBeVisible();
});

test("a show's episodes list air dates, scores, and guest stars", async ({ page }) => {
  await openTitle(page, "Fixture Series");
  await expect(page.getByText("Fixture Network")).toBeVisible();
  await expect(page.getByText("Ended", { exact: true })).toBeVisible();

  const episodes = page.getByRole("region", { name: "Episodes" });
  const pilot = episodes.getByRole("link", { name: /Pilot/u });

  await expect(pilot).toContainText("March 31, 2020");
  await expect(pilot).toContainText("★ 8.4");
  await expect(pilot).toContainText("Guest stars Gus Guest");
  await expect(pilot).toContainText("Directed by Pilot Director");
  await capture(page, "show-episodes", true);
});

test("the command menu finds people", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await page.keyboard.press(`${mod}+k`);
  await page.getByRole("combobox").fill("Weaver");

  const person = page.getByRole("option", { name: /Sigourney Weaver/u });

  await expect(person).toBeVisible();
  await capture(page, "command-menu-people");
  await person.click();
  await expect(page.getByRole("heading", { level: 1, name: "Sigourney Weaver" })).toBeVisible();
});
