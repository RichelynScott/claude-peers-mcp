/**
 * mDNS Auto-Discovery for claude-peers LAN Federation (Phase B)
 *
 * Advertises a _claude-peers._tcp service on the LAN via mDNS/Bonjour.
 * Discovers remote federation agents and auto-connects when PSK hashes match.
 * Falls back gracefully when mDNS is unavailable (WSL2 NAT, missing package).
 */

import { createHash } from "node:crypto";
import { federationLog, isWSL2 } from "./federation.ts";
import type { RemoteMachine } from "./shared/types.ts";

const SERVICE_TYPE = "claude-peers";
const PROTOCOL = "tcp";
const MDNS_VERSION = "1.0.0";
const DEDUP_COOLDOWN_MS = 5_000;
const BACKOFF_INITIAL_MS = 30_000;
const BACKOFF_ESCALATED_MS = 300_000; // 5 minutes
const MAX_FAILURES = 10;

export function pskHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

interface MdnsManagerConfig {
  federationPort: number;
  pskToken: string;
  localHostname: string;
  onPeerDiscovered: (host: string, port: number, hostname: string) => Promise<{ ok: boolean; hostname?: string; error?: string }>;
  remoteMachines: Map<string, RemoteMachine>;
}

interface BackoffEntry {
  failures: number;
  nextRetryAt: number;
}

export class MdnsManager {
  private config: MdnsManagerConfig;
  private bonjour: any = null;
  private browser: any = null;
  private service: any = null;
  private localPskHash: string;
  private dedupMap = new Map<string, number>(); // host:port -> last attempt timestamp
  private backoffMap = new Map<string, BackoffEntry>();
  private _discoveredServices = 0;
  private _autoConnections = 0;
  private _state: "active" | "disabled" = "disabled";
  private _reason?: string;

  constructor(config: MdnsManagerConfig) {
    this.config = config;
    this.localPskHash = pskHash(config.pskToken);
  }

  async start(): Promise<boolean> {
    // WSL2 NAT mode: mDNS is non-functional
    if (isWSL2()) {
      this._state = "disabled";
      this._reason = "WSL2 NAT mode — multicast not available";
      federationLog(`mDNS: ${this._reason}. Use 'federation connect <ip>:<port>' for manual connections.`);
      return false;
    }

    // Try to load bonjour-service
    try {
      const { Bonjour } = await import("bonjour-service");
      this.bonjour = new Bonjour();
    } catch {
      this._state = "disabled";
      this._reason = "bonjour-service not installed";
      federationLog(`mDNS: ${this._reason}. Install with: bun add bonjour-service`);
      return false;
    }

    // Advertise our service
    try {
      this.service = this.bonjour.publish({
        name: this.config.localHostname,
        type: SERVICE_TYPE,
        protocol: PROTOCOL,
        port: this.config.federationPort,
        txt: {
          psk_hash: this.localPskHash,
          version: MDNS_VERSION,
          hostname: this.config.localHostname,
        },
      });
      federationLog(`mDNS: advertising _${SERVICE_TYPE}._${PROTOCOL} on port ${this.config.federationPort} (psk_hash=${this.localPskHash})`);
    } catch (e) {
      this._state = "disabled";
      this._reason = `advertisement failed: ${e instanceof Error ? e.message : String(e)}`;
      federationLog(`mDNS: ${this._reason}`);
      return false;
    }

    // Browse for peers
    try {
      this.browser = this.bonjour.find({ type: SERVICE_TYPE, protocol: PROTOCOL });

      this.browser.on("up", (service: any) => {
        this.handleServiceUp(service);
      });

      this.browser.on("down", (service: any) => {
        const hostname = service.txt?.hostname || service.name || "unknown";
        federationLog(`mDNS: ${hostname} left the network`);
      });
    } catch (e) {
      federationLog(`mDNS: browser failed to start: ${e instanceof Error ? e.message : String(e)}`);
      // Still mark as active — advertisement may work even if browsing fails
    }

    this._state = "active";
    this._reason = undefined;
    return true;
  }

  private async handleServiceUp(service: any) {
    const remotePskHash = service.txt?.psk_hash;
    const remoteHostname = service.txt?.hostname || service.name || "unknown";
    const addresses: string[] = service.addresses || [];
    const port = service.port;

    // Prefer IPv4
    const ipv4 = addresses.find((a: string) => !a.includes(":"));
    if (!ipv4) {
      federationLog(`mDNS: discovered ${remoteHostname} but no IPv4 address found`);
      return;
    }

    this._discoveredServices++;
    federationLog(`mDNS: discovered ${remoteHostname} at ${ipv4}:${port} (psk_hash=${remotePskHash})`);

    // Ignore self
    if (remoteHostname === this.config.localHostname) {
      federationLog(`mDNS: ignoring self-announcement`);
      return;
    }

    // PSK hash pre-filter
    if (remotePskHash !== this.localPskHash) {
      federationLog(`mDNS: skipping ${remoteHostname} (PSK mismatch: local=${this.localPskHash} remote=${remotePskHash})`);
      return;
    }

    const key = `${ipv4}:${port}`;

    // Already connected?
    if (this.config.remoteMachines.has(key)) {
      return;
    }

    // Dedup cooldown
    const lastAttempt = this.dedupMap.get(key) ?? 0;
    if (Date.now() - lastAttempt < DEDUP_COOLDOWN_MS) {
      return;
    }

    // Backoff check
    const backoff = this.backoffMap.get(key);
    if (backoff) {
      if (backoff.failures >= MAX_FAILURES) {
        return; // Given up
      }
      if (Date.now() < backoff.nextRetryAt) {
        return; // Still in backoff
      }
    }

    this.dedupMap.set(key, Date.now());

    // Auto-connect
    federationLog(`mDNS: auto-connecting to ${remoteHostname} at ${ipv4}:${port}`);
    try {
      const result = await this.config.onPeerDiscovered(ipv4, port, remoteHostname);
      if (result.ok) {
        // Set source to mdns on the newly connected remote
        const rm = this.config.remoteMachines.get(key);
        if (rm) rm.source = "mdns";
        this._autoConnections++;
        this.backoffMap.delete(key);
        federationLog(`mDNS: auto-connected to ${result.hostname ?? remoteHostname} at ${ipv4}:${port}`);
      } else {
        this.recordFailure(key, remoteHostname, result.error ?? "unknown");
      }
    } catch (e) {
      this.recordFailure(key, remoteHostname, e instanceof Error ? e.message : String(e));
    }
  }

  private recordFailure(key: string, hostname: string, error: string) {
    const entry = this.backoffMap.get(key) ?? { failures: 0, nextRetryAt: 0 };
    entry.failures++;

    if (entry.failures >= MAX_FAILURES) {
      federationLog(`mDNS: giving up on ${hostname} after ${MAX_FAILURES} failures`);
    } else {
      const delay = entry.failures >= 3 ? BACKOFF_ESCALATED_MS : BACKOFF_INITIAL_MS;
      entry.nextRetryAt = Date.now() + delay;
      federationLog(`mDNS: failed to connect to ${hostname}: ${error} (attempt ${entry.failures}/${MAX_FAILURES}) — next retry in ${delay / 1000}s`);
    }

    this.backoffMap.set(key, entry);
  }

  stop() {
    if (this.service) {
      federationLog("mDNS: un-publishing service");
      try { this.service.stop?.(); } catch {}
    }
    if (this.browser) {
      try { this.browser.stop?.(); } catch {}
    }
    if (this.bonjour) {
      try { this.bonjour.destroy?.(); } catch {}
    }
    this._state = "disabled";
  }

  getStatus() {
    return {
      state: this._state,
      reason: this._reason,
      discovered_services: this._discoveredServices,
      auto_connections: this._autoConnections,
    };
  }
}
