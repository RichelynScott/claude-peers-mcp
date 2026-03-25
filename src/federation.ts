// federation.ts — LAN Federation Agent for claude-peers-mcp
// Phase A: Manual federation (connect by IP, PSK auth, TLS)

import { $ } from "bun";
import { existsSync, chmodSync } from "node:fs";
import { hostname } from "node:os";
import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_CERT_PATH = `${process.env.HOME}/.claude-peers-federation.crt`;
const DEFAULT_KEY_PATH = `${process.env.HOME}/.claude-peers-federation.key`;

export function federationLog(msg: string): void {
  const line = `[CPM-federation] ${msg}`;
  console.error(line);
  // Also append to log file (same pattern as broker.ts)
  try {
    const logDir = `${process.cwd()}/cpm-logs`;
    const logPath = `${logDir}/federation.log`;
    Bun.write(Bun.file(logPath), line + "\n", { append: true });
  } catch {}
}

/**
 * Get the machine's hostname, normalized for use as a peer ID prefix.
 * - Lowercase
 * - Truncated to 63 chars (DNS label max)
 * - Rejects hostnames containing colons (IPv6 — not supported)
 */
export function getMachineHostname(): string {
  const h = hostname().toLowerCase();
  if (h.includes(":")) {
    throw new Error(`[CPM-federation] Hostname "${h}" contains colons (IPv6 not supported). Set a hostname without colons.`);
  }
  return h.slice(0, 63);
}

/**
 * Auto-generate self-signed TLS certificate if not already present.
 * Prefers Ed25519, falls back to RSA-2048 if Ed25519 fails.
 */
export async function ensureTlsCert(
  certPath: string = process.env.CLAUDE_PEERS_FEDERATION_CERT || DEFAULT_CERT_PATH,
  keyPath: string = process.env.CLAUDE_PEERS_FEDERATION_KEY || DEFAULT_KEY_PATH,
): Promise<{ certPath: string; keyPath: string }> {
  if (existsSync(certPath) && existsSync(keyPath)) {
    federationLog(`TLS cert loaded from ${certPath}`);
    return { certPath, keyPath };
  }

  const cn = getMachineHostname();
  federationLog(`Generating self-signed TLS certificate (CN=${cn})...`);

  // Try Ed25519 first (faster, modern)
  try {
    await $`openssl genpkey -algorithm Ed25519 -out ${keyPath}`.quiet();
    await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days 365 -subj /CN=${cn}`.quiet();
    chmodSync(keyPath, 0o600);
    federationLog(`TLS cert generated (Ed25519) at ${certPath}`);
    return { certPath, keyPath };
  } catch {
    federationLog("Ed25519 cert generation failed, falling back to RSA-2048...");
  }

  // Fallback: RSA-2048
  try {
    await $`openssl req -newkey rsa:2048 -noenc -keyout ${keyPath} -x509 -days 365 -out ${certPath} -subj /CN=${cn}`.quiet();
    chmodSync(keyPath, 0o600);
    federationLog(`TLS cert generated (RSA-2048) at ${certPath}`);
    return { certPath, keyPath };
  } catch (err) {
    throw new Error(`[CPM-federation] Failed to generate TLS certificate: ${err}`);
  }
}

// --- HMAC Message Signing ---

/**
 * Sign a message body with HMAC-SHA256.
 * Canonical JSON: sorted top-level keys, nested structures preserved.
 *
 * IMPORTANT: We build a new object with sorted top-level keys rather than using
 * JSON.stringify's replacer array. The replacer array acts as a whitelist that
 * STRIPS all nested object keys (e.g., metadata always becomes `{}`).
 * Verified: `JSON.stringify({a:1, b:{x:2}}, ["a","b"])` → `{"a":1,"b":{}}`
 */
export function signMessage(body: Record<string, unknown>, psk: string): string {
  const canonicalObj: Record<string, unknown> = {};
  for (const key of Object.keys(body).sort()) {
    canonicalObj[key] = body[key];
  }
  return createHmac("sha256", psk).update(JSON.stringify(canonicalObj)).digest("hex");
}

/**
 * Verify HMAC-SHA256 signature using constant-time comparison.
 */
export function verifySignature(body: Record<string, unknown>, signature: string, psk: string): boolean {
  const expected = signMessage(body, psk);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// --- Subnet Utilities ---

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
}

/**
 * Check if an IP address is within a CIDR subnet.
 */
export function ipInSubnet(ip: string, cidr: string): boolean {
  const [subnet, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr);
  if (isNaN(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(subnet) & mask);
}

/**
 * Detect if running inside WSL2.
 * Checks for WSLInterop binfmt entry or WSL_DISTRO_NAME env var.
 */
function isWSL2(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
  } catch {
    return false;
  }
}

/**
 * Auto-detect the local subnet from default route.
 *
 * On WSL2, the default route returns the internal NAT range (172.x.x.x/20),
 * NOT the actual LAN subnet. Since WSL2's network topology makes subnet
 * restriction unreliable, we default to 0.0.0.0/0 (allow all) on WSL2
 * and rely on PSK auth + TLS for security instead.
 *
 * Falls back to /24 of first non-internal IPv4 interface on native Linux.
 * Manual override: set CLAUDE_PEERS_FEDERATION_SUBNET env var.
 */
export async function detectSubnet(): Promise<string> {
  // WSL2: subnet auto-detection is fundamentally broken (NAT range != LAN range)
  if (isWSL2()) {
    federationLog("WSL2 detected — subnet auto-detection unreliable (NAT range != LAN). Defaulting to 0.0.0.0/0 (allow all). Set CLAUDE_PEERS_FEDERATION_SUBNET to restrict.");
    return "0.0.0.0/0";
  }

  try {
    // Primary: ip route show default → get gateway interface → get that interface's IP
    const routeProc = Bun.spawn(["ip", "route", "show", "default"], { stdout: "pipe", stderr: "ignore" });
    const routeText = await new Response(routeProc.stdout).text();
    // Example: "default via 192.168.4.1 dev eth0"
    const devMatch = routeText.match(/dev\s+(\S+)/);
    if (devMatch) {
      const ifaceProc = Bun.spawn(["ip", "-4", "addr", "show", devMatch[1]], { stdout: "pipe", stderr: "ignore" });
      const ifaceText = await new Response(ifaceProc.stdout).text();
      // Example: "inet 192.168.4.10/24 ..."
      const inetMatch = ifaceText.match(/inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/);
      if (inetMatch) {
        const ip = inetMatch[1];
        const prefix = parseInt(inetMatch[2]);
        // Calculate network address
        const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
        const network = (ipToInt(ip) & mask) >>> 0;
        const networkIp = [(network >>> 24) & 255, (network >>> 16) & 255, (network >>> 8) & 255, network & 255].join(".");
        const subnet = `${networkIp}/${prefix}`;
        federationLog(`Auto-detected subnet: ${subnet} (from default route, interface ${devMatch[1]})`);
        return subnet;
      }
    }
  } catch {}

  // Fallback: use os.networkInterfaces()
  const { networkInterfaces } = await import("node:os");
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs || []) {
      if (addr.family === "IPv4" && !addr.internal && !addr.address.startsWith("172.") && !addr.address.startsWith("100.")) {
        const subnet = `${addr.address}/24`;
        federationLog(`Auto-detected subnet: ${subnet} (from networkInterfaces fallback)`);
        return subnet;
      }
    }
  }
  federationLog("Subnet auto-detection failed — defaulting to 0.0.0.0/0 (allow all)");
  return "0.0.0.0/0"; // Allow all if detection fails
}

// --- Federation HTTPS fetch via curl (Bun 1.3.x workaround) ---

/**
 * Fetch from a federation HTTPS endpoint (self-signed cert).
 * Bun 1.3.x fetch() doesn't support tls: { rejectUnauthorized: false },
 * so we use curl -sk as a workaround.
 */
export async function federationFetch<T>(
  url: string,
  body: Record<string, unknown>,
  pskToken: string,
  timeoutMs: number = 5000
): Promise<{ ok: boolean; status: number; data: T }> {
  const proc = Bun.spawn([
    "curl", "-sk",
    "--max-time", String(Math.ceil(timeoutMs / 1000)),
    "-X", "POST",
    "-H", "Content-Type: application/json",
    "-H", `X-Claude-Peers-PSK: ${pskToken}`,
    "-w", "\n%{http_code}",
    "-d", JSON.stringify(body),
    url
  ], { stdout: "pipe", stderr: "ignore" });

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  const lines = output.trimEnd().split("\n");
  const statusCode = parseInt(lines.pop() || "0");
  const responseBody = lines.join("\n");

  let data: T;
  try { data = JSON.parse(responseBody); }
  catch { data = responseBody as unknown as T; }

  return { ok: statusCode >= 200 && statusCode < 300, status: statusCode, data };
}
