#!/usr/bin/env node
// Proves that the browser host ignores Docker network changes, and that it reports them when it
// shares the host network. It starts one browser host on the host network and one isolated, both
// against a local server, and stops a bridge container of its own while each has 16 slow requests
// open. Chromium runs 6 at a time per server and cancels the queued rest on an address change.
//
//   node check-network.mjs [--trials N] [--image IMG]
//
// It starts and stops its container on purpose, which can fail requests in any other Chromium on
// this host, so run it deliberately. Exit 0: isolated lost nothing and the host-network control
// lost requests. Exit 1: isolated lost requests or failed; each result's `error` says which.
// Exit 2: the control lost none, so nothing is proven.
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const { values: flags } = parseArgs({
  strict: true,
  options: {
    trials: { type: "string", default: "2" },
    image: { type: "string", default: "ghcr.io/lmdevv/media:main" },
  },
});
const browserJs = fileURLToPath(new URL("browser.mjs", import.meta.url));
// The Chromium verify-movies.sh picks: CHROMIUM_PATH, else the system one on NixOS, else Playwright's.
const chromium =
  process.env.CHROMIUM_PATH ||
  (existsSync("/etc/NIXOS") ? spawnSync("sh", ["-c", "command -v chromium"], { encoding: "utf8" }).stdout.trim() : "");
const container = `movies-verify-netcheck-${process.pid}`;
const docker = (...args) => promisify(execFile)("docker", args);
const NETWORKS = ["host", "isolated"];
const REQUESTS = 16;

const server = createServer((request, response) => {
  if (request.url.startsWith("/slow")) {
    setTimeout(() => response.end("ok"), 3000);
    return;
  }
  response.writeHead(200, { "content-type": "text/html" }).end("<title>network check</title>");
});
const listening = (target) => new Promise((done) => target.listen(0, "127.0.0.1", () => done(target.address().port)));
const base = `http://localhost:${await listening(server)}`;
const convex = createServer((request, response) => response.end());
const convexUrl = `http://localhost:${await listening(convex)}`;

const hosts = new Map();
const drive = (network, ...args) =>
  new Promise((done) => {
    const child = spawn("node", [browserJs, ...args, "--state", hosts.get(network).state]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });

const cleanup = () => {
  spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  for (const { process: host, state } of hosts.values()) {
    host.kill("SIGTERM");
    rmSync(state, { recursive: true, force: true });
  }
  server.closeAllConnections();
  server.close();
  convex.close();
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

const results = [];
try {
  for (const network of NETWORKS) {
    const state = mkdtempSync("/tmp/movies-netcheck-");
    const host = spawn("node", [browserJs, "serve", "--state", state, "--base", base, "--convex", convexUrl], {
      env: { ...process.env, ...(chromium ? { CHROMIUM_PATH: chromium } : {}), MEDIA_VERIFY_BROWSER_NETWORK: network },
      stdio: ["ignore", "ignore", "inherit"],
    });
    hosts.set(network, { process: host, state });
  }
  for (const network of NETWORKS) {
    for (let tries = 0; (await drive(network, "url")).status !== 0; tries += 1) {
      if (tries > 100) throw new Error(`the ${network} browser host did not start`);
      await sleep(200);
    }
    const opened = await drive(network, "open", "/");
    if (opened.status !== 0) throw new Error(`the ${network} browser host could not open ${base}: ${opened.stderr}`);
  }
  await docker("image", "inspect", flags.image).catch(() => docker("pull", "-q", flags.image));
  await docker(
    "create", "--name", container, "--label", "movies.verify.check=network", "--network", "bridge",
    "--entrypoint", "sleep", flags.image, "600",
  );

  const fetches = `Promise.all(Array.from({ length: ${REQUESTS} }, (_, i) =>
    fetch("/slow?" + i).then((r) => r.text(), (e) => String(e))))`;
  for (let trial = 1; trial <= Number(flags.trials); trial += 1) {
    await docker("start", container);
    // The container's addresses keep arriving for a few seconds after it starts; let them land, so
    // only the stop changes an address while the requests are open.
    await sleep(6000);
    const pending = NETWORKS.map((network) => drive(network, "eval", "--js", fetches));
    await sleep(500);
    await docker("stop", "-t", "0", container);
    const outcomes = await Promise.all(pending);
    NETWORKS.forEach((network, index) => {
      const { status, stdout, stderr } = outcomes[index];
      const answers = status === 0 ? JSON.parse(stdout) : [];
      const reported = /(\d+) requests failed with net::ERR_NETWORK_CHANGED/.exec(stderr);
      results.push({
        trial,
        network,
        failed: status === 0 ? answers.filter((answer) => answer !== "ok").length : null,
        reportedNetworkChanged: reported ? Number(reported[1]) : 0,
        exit: status,
        ...(status === 0 ? {} : { error: stderr.trim().split("\n")[0] }),
      });
    });
  }
} finally {
  cleanup();
}

for (const result of results) console.log(JSON.stringify(result));
const lost = (network) =>
  results.filter((result) => result.network === network).reduce((sum, result) => sum + result.reportedNetworkChanged, 0);
const isolatedClean = results.every((result) => result.network !== "isolated" || (result.exit === 0 && result.failed === 0));
console.log(JSON.stringify({ hostNetworkChanged: lost("host"), isolatedNetworkChanged: lost("isolated"), isolatedClean }));
if (!isolatedClean || lost("isolated") > 0) process.exit(1);
if (lost("host") === 0) {
  console.error("inconclusive: the host-network browser lost no requests, so this run proves nothing");
  process.exit(2);
}
