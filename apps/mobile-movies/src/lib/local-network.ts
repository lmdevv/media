/**
 * Whether an address is on the local network, where iOS asks before the app may connect (A11) and
 * a refusal makes the server look unreachable (A12). Loopback is not local network and needs no
 * permission. Decided from the address alone; iOS offers no way to read the permission.
 */

const IPV4 = /^(?<a>\d{1,3})\.(?<b>\d{1,3})\.\d{1,3}\.\d{1,3}$/u;

const privateIpv4 = (host: string): boolean => {
  const groups = IPV4.exec(host)?.groups;

  if (groups === undefined) return false;
  const a = Number(groups["a"]);
  const b = Number(groups["b"]);

  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    // Link-local, where devices land without DHCP.
    (a === 169 && b === 254)
  );
};

const privateIpv6 = (host: string): boolean => {
  const bare = host.replace(/^\[|\]$/gu, "").toLowerCase();

  return /^f[cd][0-9a-f]{2}:/u.test(bare) || /^fe[89ab][0-9a-f]:/u.test(bare);
};

const hostOf = (url: string): string | null => {
  const match = /^[a-z][a-z\d+.-]*:\/\/(?<host>\[[^\]]+\]|[^/:?#]+)/iu.exec(url.trim());

  return match?.groups?.["host"]?.toLowerCase() ?? null;
};

/**
 * Whether `url` points at this network: a private or link-local IP, a `.local` (Bonjour) name, or
 * a bare name such as `nas` that only the local resolver knows.
 */
export const isLocalNetworkUrl = (url: string): boolean => {
  const host = hostOf(url);

  if (host === null || host === "localhost") return false;

  return (
    privateIpv4(host) ||
    privateIpv6(host) ||
    host.endsWith(".local") ||
    (!host.includes(".") && !host.includes(":") && !host.startsWith("["))
  );
};

/** The host and port people recognize, such as `cinema.home` or `192.168.1.20:8080`. */
export const displayHost = (url: string): string =>
  url.replace(/^[a-z][a-z\d+.-]*:\/\//iu, "").replace(/\/.*$/u, "");
