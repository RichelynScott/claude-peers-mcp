/**
 * Persistent config file support for claude-peers.
 *
 * Reads ~/.claude-peers-config.json on startup. Env vars override config
 * file values for backwards compatibility.
 *
 * Config file format:
 * {
 *   "federation": {
 *     "enabled": true,
 *     "port": 7900,
 *     "subnet": "0.0.0.0/0"
 *   }
 * }
 */
import * as fs from "node:fs";
import { homedir } from "node:os";

export const CONFIG_PATH = `${homedir()}/.claude-peers-config.json`;

export interface FederationRemote {
  host: string;
  port: number;
  label?: string;
}

export interface PeersConfig {
  federation?: {
    enabled?: boolean;
    port?: number;
    subnet?: string;
    remotes?: FederationRemote[];
  };
  server?: {
    startup_timeout_ms?: number;
  };
}

/**
 * Add a remote to the config file's federation.remotes array.
 * Deduplicates by host:port (upsert). Returns the updated config.
 */
export function addRemoteToConfig(remote: FederationRemote): PeersConfig {
  const config = loadConfig();
  if (!config.federation) config.federation = {};
  if (!config.federation.remotes) config.federation.remotes = [];

  const key = `${remote.host}:${remote.port}`;
  const idx = config.federation.remotes.findIndex(r => `${r.host}:${r.port}` === key);
  if (idx >= 0) {
    config.federation.remotes[idx] = remote;
  } else {
    config.federation.remotes.push(remote);
  }
  writeConfig(config);
  return config;
}

/**
 * Remove a remote from the config file's federation.remotes array.
 * Returns the updated config.
 */
export function removeRemoteFromConfig(host: string, port: number): PeersConfig {
  const config = loadConfig();
  if (!config.federation?.remotes) return config;

  const key = `${host}:${port}`;
  config.federation.remotes = config.federation.remotes.filter(r => `${r.host}:${r.port}` !== key);
  writeConfig(config);
  return config;
}

/**
 * Load config from ~/.claude-peers-config.json.
 * Returns empty object if file doesn't exist or is invalid JSON.
 * Never throws — missing/malformed config is silently ignored.
 */
export function loadConfig(): PeersConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const content = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(content) as PeersConfig;
  } catch {
    return {};
  }
}

/**
 * Write config to ~/.claude-peers-config.json.
 * Creates the file with 0644 permissions.
 */
export function writeConfig(config: PeersConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o644,
  });
}
