/**
 * Lemonade Server network scan — UDP beacon listening + HTTP probing.
 *
 * The Lemonade Server announces itself by broadcasting a small JSON beacon
 * (`{"service":"lemonade","hostname":"…","url":"http://<ip>:<port>/api/v1/"}`)
 * to UDP port 13305 every 2 s — to the broadcast address of every RFC1918
 * interface and to loopback (server source: `network_beacon.cpp`). This
 * module listens for those beacons the same way the `lemonade scan` CLI
 * command does, and additionally probes a fixed set of hosts
 * (localhost, the default gateway, plus caller-supplied hosts) on the
 * Lemonade default port — the gateway probe is what makes discovery work
 * across the WSL2 boundary, where the Windows host is the distro's gateway
 * but UDP broadcasts do not cross. The probes are complemented by a sweep
 * of every address in the local RFC1918 subnets (prefix /24 or smaller):
 * the beacon is unusable while a local Lemonade app runs (its sender socket
 * holds the fixed port without SO_REUSEADDR), and a server may disable its
 * beacon outright — the sweep finds the server either way.
 *
 * The scan is a best-effort discovery aid: it never throws, and an empty
 * result is a normal outcome (no server running, broadcast disabled, or a
 * network without RFC1918 IPv4).
 */

import dgram from "node:dgram";
import { readFile } from "node:fs/promises";
import * as os from "node:os";

/** One server found by a scan. */
export interface ScannedServer {
	/** Normalized server origin, e.g. `http://192.168.1.5:13305`. */
	origin: string;
	/** Hostname advertised by the beacon (beacon-sourced entries only). */
	hostname?: string;
	/** How the server was found. */
	source: "beacon" | "probe";
}

/** The outcome of a scan, including what was probed (for diagnostics). */
export interface ScanResult {
	servers: ScannedServer[];
	/** `host:port` strings that were probed, in probe order. */
	probed: string[];
	/** Subnets swept, e.g. `192.168.0.0/24` (for diagnostics). */
	swept: string[];
	/** Set when the beacon listener could not bind (e.g. a local Lemonade
	 *  app holds the port without SO_REUSEADDR) — the sweep still runs. */
	beaconError?: string;
}

export interface ScanOptions {
	/** Beacon listen duration (default 5000 ms — the server broadcasts every
	 *  2 s, so this yields 2–3 chances per server). */
	beaconMs?: number;
	/** Port to listen for beacons on (default 13305 — the fixed beacon
	 *  port). */
	beaconPort?: number;
	/** Per-probe timeout (default 1000 ms). */
	probeMs?: number;
	/** Port to probe (default 13305 — the Lemonade default). */
	probePort?: number;
	/** Extra hosts to probe (localhost and the default gateway are always
	 *  probed). */
	probeHosts?: string[];
	/** Sweep the local RFC1918 subnets (prefix /24 or smaller) in addition
	 *  to the beacon and the fixed probes (default true). */
	sweep?: boolean;
	/** Aborts the scan early (e.g. the user cancelled the login). */
	signal?: AbortSignal;
}

/** The fixed beacon port (the server hard-codes it so clients don't have to
 *  scan — `network_beacon.cpp`). */
const BEACON_PORT = 13305;
/** Beacon listen window — the server broadcasts every 2 s, so 5 s yields
 *  2–3 chances per server. Exported: the login countdown counts down from
 *  it. */
export const DEFAULT_BEACON_MS = 5000;
const DEFAULT_PROBE_MS = 1000;
const DEFAULT_PROBE_PORT = 13305;

// ── test hooks ──────────────────────────────────────────────────────────────

/** Test hook: shorten the scan phases (null restores the defaults). */
let scanParamsForTests:
	| { beaconMs?: number; probeMs?: number; sweep?: boolean }
	| undefined;
export function setScanParamsForTests(
	params: { beaconMs?: number; probeMs?: number; sweep?: boolean } | null,
): void {
	scanParamsForTests = params ?? undefined;
}

/** Test hook: replace the whole scan (null restores the real one). */
let scanOverrideForTests:
	| ((options: ScanOptions) => Promise<ScanResult>)
	| undefined;
export function setScanForTests(
	fn: ((options: ScanOptions) => Promise<ScanResult>) | null,
): void {
	scanOverrideForTests = fn ?? undefined;
}

// ── gateway ─────────────────────────────────────────────────────────────────

/**
 * Parse `/proc/net/route` text and return the default route's gateway as a
 * dotted quad, or undefined when there is no default route.
 *
 * Columns: `Iface Destination Gateway Flags …` — the default route is the
 * line with `Destination` `00000000`; `Gateway` is a little-endian hex
 * uint32 (`01001AC0` → `192.168.0.1`).
 */
export function parseDefaultGateway(routeText: string): string | undefined {
	for (const line of routeText.split("\n")) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 3 || cols[1] !== "00000000") continue;
		const gw = Number.parseInt(cols[2], 16);
		if (!Number.isInteger(gw) || gw === 0) continue;
		return `${gw & 0xff}.${(gw >>> 8) & 0xff}.${(gw >>> 16) & 0xff}.${
			(gw >>> 24) & 0xff
		}`;
	}
	return undefined;
}

/** Read the default gateway from `/proc/net/route` (Linux only). */
export async function readDefaultGateway(): Promise<string | undefined> {
	try {
		return parseDefaultGateway(await readFile("/proc/net/route", "utf8"));
	} catch {
		return undefined; // non-Linux host or unreadable
	}
}

// ── subnet sweep ────────────────────────────────────────────────────────────
//
// The beacon is the primary discovery mechanism, but it is unusable while a
// local Lemonade app runs (its sender socket binds the fixed port 13305
// without SO_REUSEADDR, so the listener gets EADDRINUSE — the same
// limitation the `lemonade scan` CLI has). The sweep is the reliable
// fallback: it probes every address of the local RFC1918 subnets (prefix
// /24 or smaller), so a LAN server is found even when no beacon arrives
// (app holding the port, `broadcast: false`, a different network segment).
// Closed ports answer with an instant RST, so a /24 sweep usually finishes
// well inside the probe timeout.

/** Count the set bits of a dotted-quad netmask (255.255.255.0 → 24);
 *  returns 0 for a malformed or non-contiguous mask. */
export function netmaskToPrefix(netmask: string): number {
	const octets = netmask.split(".").map(Number);
	if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
		return 0;
	}
	let prefix = 0;
	for (const o of octets) {
		for (let bit = 7; bit >= 0; bit--) {
			if (o & (1 << bit)) prefix++;
			else break;
		}
	}
	const value =
		((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
	const expected =
		prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return value === expected ? prefix : 0;
}

/** Dotted quad → uint32 (NaN when malformed). */
function ipToNumber(ip: string): number {
	const octets = ip.split(".").map(Number);
	if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
		return NaN;
	}
	return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

/** uint32 → dotted quad. */
function numberToIp(n: number): string {
	return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

/**
 * The probeable hosts of the subnet containing `address` with the given
 * prefix: every address but the network and broadcast ones (a /31 has no
 * broadcast — both ends are returned). Returns [] for a subnet bigger than
 * /24 (too many hosts to sweep) or a malformed input.
 */
export function subnetHosts(address: string, prefix: number): string[] {
	if (!Number.isInteger(prefix) || prefix < 24 || prefix > 31) return [];
	const addr = ipToNumber(address);
	if (Number.isNaN(addr)) return [];
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	const network = addr & mask;
	const size = 32 - prefix;
	const count = 1 << size; // ≤ 256 for prefix ≥ 24
	const hosts: string[] = [];
	for (let i = 0; i < count; i++) {
		if (count > 2 && (i === 0 || i === count - 1)) continue; // network + broadcast
		hosts.push(numberToIp((network + i) >>> 0));
	}
	return hosts;
}

/**
 * The local RFC1918 subnets to sweep, as `{ subnet, hosts }` pairs
 * (deduped by `subnet`). `ifaces` is injectable for tests; by default
 * `os.networkInterfaces()` is used (no process spawning).
 */
export function localSweepSubnets(
	ifaces: Record<string, os.NetworkInterfaceInfo[] | undefined> =
		os.networkInterfaces(),
): { subnet: string; hosts: string[] }[] {
	const seen = new Set<string>();
	const out: { subnet: string; hosts: string[] }[] = [];
	for (const list of Object.values(ifaces)) {
		for (const iface of list ?? []) {
			if (iface.family !== "IPv4" || iface.internal) continue;
			const addr = ipToNumber(iface.address);
			if (Number.isNaN(addr)) continue;
			// RFC1918 only — public addresses and CGNAT are not swept.
			const o1 = (addr >>> 24) & 0xff;
			const o2 = (addr >>> 16) & 0xff;
			const rfc1918 =
				o1 === 10 ||
				(o1 === 172 && o2 >= 16 && o2 <= 31) ||
				(o1 === 192 && o2 === 168);
			if (!rfc1918) continue;
			const prefix = netmaskToPrefix(iface.netmask);
			if (prefix < 1 || prefix > 24) continue;
			const network = (addr & (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0)) >>> 0;
			const subnet = `${numberToIp(network)}/${prefix}`;
			if (seen.has(subnet)) continue;
			seen.add(subnet);
			out.push({ subnet, hosts: subnetHosts(iface.address, prefix) });
		}
	}
	return out;
}

// ── beacon listener ─────────────────────────────────────────────────────────

/**
 * Listen for Lemonade beacons on UDP 13305 for `ms` milliseconds.
 *
 * `reuseAddr` is required: a running Lemonade app may already hold the port,
 * and SO_REUSEADDR lets every bound socket receive the broadcast datagrams.
 * (In practice the app's sender socket does NOT set SO_REUSEADDR, so the
 * bind fails while the app runs — the failure is reported to the caller and
 * the subnet sweep covers the gap.) Resolves when the duration elapses, the
 * socket errors, or `signal` aborts; the resolved value is an error string
 * when the socket could not bind.
 */
function listenForBeacons(
	ms: number,
	port: number,
	signal: AbortSignal | undefined,
	onBeacon: (server: ScannedServer) => void,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		let socket: dgram.Socket | null = null;
		let timer: NodeJS.Timeout | undefined;
		let bindError: string | undefined;
		const finish = (): void => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			if (socket) {
				try {
					socket.close();
				} catch {
					// already closed
				}
				socket = null;
			}
			resolve(bindError);
		};
		try {
			socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
			socket.on("error", (e: NodeJS.ErrnoException) => {
				// EADDRINUSE: a local Lemonade app holds the port (its sender
				// socket has no SO_REUSEADDR) — the sweep is the fallback.
				bindError = e.code ? `${e.code} on port ${port}` : e.message;
				finish();
			});
			socket.on("message", (msg, rinfo) => {
				try {
					const beacon = JSON.parse(msg.toString()) as {
						service?: unknown;
						hostname?: unknown;
						url?: unknown;
					};
					if (beacon.service !== "lemonade" || typeof beacon.url !== "string")
						return;
					// The beacon advertises `http://<ip>:<port>/api/v1/` — the
					// origin is the server base (the extension appends `/v1`
					// itself), so the path is deliberately dropped.
					const origin = new URL(beacon.url).origin;
					onBeacon({
						origin,
						hostname:
							typeof beacon.hostname === "string" && beacon.hostname
								? beacon.hostname
								: rinfo.address,
						source: "beacon",
					});
				} catch {
					// not a beacon datagram
				}
			});
			socket.bind(port, () => {
				timer = setTimeout(finish, ms);
				signal?.addEventListener("abort", finish, { once: true });
			});
		} catch (e) {
			bindError = e instanceof Error ? e.message : String(e);
			finish();
		}
	});
}

// ── probing ─────────────────────────────────────────────────────────────────

/** Bracket a raw IPv6 host for use in a URL (IPv4/hostnames pass through). */
function hostWithBrackets(host: string): string {
	return host.includes(":") ? `[${host}]` : host;
}

/**
 * Reachability check for the `/login` candidate list: `GET <base>/v1/health`
 * with a short timeout. 2xx (healthy) or 401 (up, wants a key) counts as
 * online; anything else — including no response — is offline.
 */
export async function probeServerStatus(
	base: string,
	timeoutMs = DEFAULT_PROBE_MS,
	signal?: AbortSignal,
): Promise<"online" | "offline"> {
	try {
		const res = await fetch(`${base}/v1/health`, {
			signal: AbortSignal.any([
				signal ?? new AbortController().signal,
				AbortSignal.timeout(timeoutMs),
			]),
		});
		return res.ok || res.status === 401 ? "online" : "offline";
	} catch {
		return "offline";
	}
}

/**
 * Whether the fire-and-forget STARTUP scan should run on this platform.
 *
 * Linux only: the scan's beacon listener binds UDP 13305 and receives
 * inbound traffic, which makes macOS's application firewall (and Windows
 * Defender Firewall) prompt about the node process on the first scan — a
 * bad surprise at pi startup. Linux firewalls don't prompt. The on-demand
 * `/login` scan is unaffected: there the user explicitly asked for a
 * network scan, so a prompt is acceptable.
 */
export function shouldRunStartupScan(
	platform: NodeJS.Platform = process.platform,
): boolean {
	return platform === "linux";
}

// ── scan ────────────────────────────────────────────────────────────────────

/**
 * Scan for Lemonade servers: listen for UDP beacons, probe a fixed set of
 * hosts, and sweep the local RFC1918 subnets — in parallel. Results are
 * deduped by origin.
 *
 * Probed hosts: `127.0.0.1`, the default gateway (in WSL2 that is the
 * Windows host), and any caller-supplied hosts (e.g. the saved credential's
 * host or the env-configured host). Swept subnets: every local RFC1918
 * interface with a prefix of /24 or smaller (each address probed once) —
 * the mechanism that finds a LAN server when the beacon is unavailable
 * (a local Lemonade app holds the beacon port) or disabled on the server.
 */
export async function scanLemonadeServers(
	options: ScanOptions = {},
): Promise<ScanResult> {
	if (scanOverrideForTests) return scanOverrideForTests(options);
	const beaconMs = options.beaconMs ?? scanParamsForTests?.beaconMs ?? DEFAULT_BEACON_MS;
	const beaconPort = options.beaconPort ?? BEACON_PORT;
	const probeMs = options.probeMs ?? scanParamsForTests?.probeMs ?? DEFAULT_PROBE_MS;
	const probePort = options.probePort ?? DEFAULT_PROBE_PORT;
	const sweep = options.sweep ?? scanParamsForTests?.sweep ?? true;
	const { signal } = options;

	const found = new Map<string, ScannedServer>();

	// Probe hosts: always localhost + default gateway, plus caller extras.
	const probedHosts = ["127.0.0.1"];
	const gateway = await readDefaultGateway();
	if (gateway && gateway !== "127.0.0.1") probedHosts.push(gateway);
	for (const host of options.probeHosts ?? []) {
		if (host && !probedHosts.includes(host)) probedHosts.push(host);
	}

	// Subnet sweep: every address of the local RFC1918 subnets (deduped
	// against the fixed set and across interfaces).
	const swept: string[] = [];
	const sweepHosts: string[] = [];
	if (sweep) {
		for (const { subnet, hosts } of localSweepSubnets()) {
			swept.push(subnet);
			for (const host of hosts) {
				if (!probedHosts.includes(host)) sweepHosts.push(host);
			}
		}
	}

	let beaconError: string | undefined;
	const beacon = signal?.aborted
		? Promise.resolve()
		: listenForBeacons(beaconMs, beaconPort, signal, (server) => {
				if (!found.has(server.origin)) found.set(server.origin, server);
		  }).then((error) => {
			beaconError = error;
		});

	const probes = Promise.all(
		[...probedHosts, ...sweepHosts].map(async (host) => {
			if (signal?.aborted) return;
			const origin = `http://${hostWithBrackets(host)}:${probePort}`;
			try {
				const res = await fetch(`${origin}/v1/health`, {
					signal: AbortSignal.any([
						signal ?? new AbortController().signal,
						AbortSignal.timeout(probeMs),
					]),
				});
				if ((res.ok || res.status === 401) && !found.has(origin)) {
					found.set(origin, { origin, source: "probe" });
				}
			} catch {
				// offline — probing is best-effort
			}
		}),
	);

	await Promise.allSettled([beacon, probes]);
	return {
		servers: [...found.values()],
		probed: probedHosts.map((host) => `${host}:${probePort}`),
		swept,
		...(beaconError ? { beaconError } : {}),
	};
}
