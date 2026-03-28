#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/cli.ts
import * as path from "path";
import * as fs3 from "fs";

// src/shared/token.ts
import * as fs from "fs";
var TOKEN_PATH = process.env.CLAUDE_PEERS_TOKEN ?? `${process.env.HOME}/.claude-peers-token`;
function readTokenSync() {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`Token file not found at ${TOKEN_PATH}. Start the broker first (it auto-generates the token), or run: bun src/cli.ts rotate-token`);
  }
  const content = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
  if (!content) {
    throw new Error(`Token file is empty at ${TOKEN_PATH}. Regenerate with: bun src/cli.ts rotate-token`);
  }
  return content;
}

// src/shared/config.ts
import * as fs2 from "fs";
import { homedir } from "os";
var CONFIG_PATH = `${homedir()}/.claude-peers-config.json`;
function loadConfig() {
  try {
    if (!fs2.existsSync(CONFIG_PATH))
      return {};
    const content = fs2.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}
function writeConfig(config) {
  fs2.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + `
`, {
    mode: 384
  });
}

// src/federation.ts
var {$ } = globalThis.Bun;
import { existsSync as existsSync3, chmodSync, appendFileSync } from "fs";
import { hostname } from "os";
var DEFAULT_CERT_PATH = `${process.env.HOME}/.claude-peers-federation.crt`;
var DEFAULT_KEY_PATH = `${process.env.HOME}/.claude-peers-federation.key`;
function federationLog(msg) {
  const line = `[CPM-federation] ${msg}`;
  console.error(line);
  try {
    const logDir = `${process.cwd()}/cpm-logs`;
    const logPath = `${logDir}/federation.log`;
    appendFileSync(logPath, line + `
`);
  } catch {}
}
function getMachineHostname() {
  const h = hostname().toLowerCase();
  if (h.includes(":")) {
    throw new Error(`[CPM-federation] Hostname "${h}" contains colons (IPv6 not supported). Set a hostname without colons.`);
  }
  return h.slice(0, 63);
}
async function ensureTlsCert(certPath = process.env.CLAUDE_PEERS_FEDERATION_CERT || DEFAULT_CERT_PATH, keyPath = process.env.CLAUDE_PEERS_FEDERATION_KEY || DEFAULT_KEY_PATH) {
  if (existsSync3(certPath) && existsSync3(keyPath)) {
    federationLog(`TLS cert loaded from ${certPath}`);
    return { certPath, keyPath };
  }
  const cn = getMachineHostname();
  federationLog(`Generating self-signed TLS certificate (CN=${cn})...`);
  try {
    await $`openssl req -newkey rsa:2048 -noenc -keyout ${keyPath} -x509 -days 365 -out ${certPath} -subj /CN=${cn}`.quiet();
    chmodSync(keyPath, 384);
    federationLog(`TLS cert generated (RSA-2048) at ${certPath}`);
    return { certPath, keyPath };
  } catch {
    federationLog("RSA-2048 cert generation failed, falling back to Ed25519...");
  }
  try {
    await $`openssl genpkey -algorithm Ed25519 -out ${keyPath}`.quiet();
    await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days 365 -subj /CN=${cn}`.quiet();
    chmodSync(keyPath, 384);
    federationLog(`TLS cert generated (Ed25519) at ${certPath}`);
    return { certPath, keyPath };
  } catch (err) {
    throw new Error(`[CPM-federation] Failed to generate TLS certificate: ${err}`);
  }
}

// src/cli.ts
var BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
var BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
var authToken = "";
async function brokerFetch(fetchPath, body) {
  const headers = {};
  if (body) {
    headers["Content-Type"] = "application/json";
  }
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const opts = body ? {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  } : { headers };
  const res = await fetch(`${BROKER_URL}${fetchPath}`, {
    ...opts,
    signal: AbortSignal.timeout(3000)
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json();
}
function getGitRepoName(cwd) {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore"
    });
    if (proc.exitCode !== 0)
      return null;
    const toplevel = new TextDecoder().decode(proc.stdout).trim();
    if (!toplevel)
      return null;
    return path.basename(toplevel);
  } catch {
    return null;
  }
}
function getGitBranchName(cwd) {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore"
    });
    if (proc.exitCode !== 0)
      return null;
    const branch = new TextDecoder().decode(proc.stdout).trim();
    if (!branch)
      return null;
    return branch;
  } catch {
    return null;
  }
}
async function getTaskMasterInProgress(cwd) {
  try {
    const whichProc = Bun.spawnSync(["which", "task-master"], {
      stdout: "pipe",
      stderr: "ignore"
    });
    if (whichProc.exitCode !== 0)
      return null;
    const proc = Bun.spawn(["task-master", "list", "--status=in-progress"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore"
    });
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve(null), 2000);
    });
    const resultPromise = (async () => {
      const text = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code !== 0)
        return null;
      const trimmed = text.trim();
      if (!trimmed)
        return null;
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.length;
        }
        return null;
      } catch {
        const lines = trimmed.split(`
`).filter((line) => {
          const l = line.trim();
          return l.length > 0 && !l.startsWith("-") && !l.startsWith("=") && !l.startsWith("ID");
        });
        return lines.length > 0 ? lines.length : null;
      }
    })();
    const result = await Promise.race([resultPromise, timeoutPromise]);
    try {
      proc.kill();
    } catch {}
    return result;
  } catch {
    return null;
  }
}
function buildSummary(opts) {
  const { repoName, branch, cwd, taskCount } = opts;
  const hasGit = repoName !== null && branch !== null;
  const prefix = hasGit ? `[${repoName}:${branch}] ` : "";
  if (hasGit && taskCount !== null && taskCount > 0) {
    return `${prefix}${taskCount} in-progress task${taskCount === 1 ? "" : "s"}`;
  }
  return `${prefix}Working in ${cwd}`;
}
function formatUptime(isoTimestamp) {
  const connected = new Date(isoTimestamp).getTime();
  const now = Date.now();
  const diffMs = Math.max(0, now - connected);
  const totalSec = Math.floor(diffMs / 1000);
  if (totalSec < 60)
    return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60)
    return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24)
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}
async function federationSetupWSL2(fedPort) {
  console.log("  4. Setting up Windows port forwarding...");
  console.log("");
  console.log("     Note: On WSL2, subnet restriction is set to 0.0.0.0/0 (allow all)");
  console.log("     because Windows port forwarding rewrites source IPs. Security is");
  console.log("     provided by PSK authentication + TLS encryption.");
  console.log("");
  console.log("     Ensure your environment includes:");
  console.log("       export CLAUDE_PEERS_FEDERATION_SUBNET=0.0.0.0/0");
  console.log("");
  const wslIpProc = Bun.spawnSync(["hostname", "-I"], {
    stdout: "pipe",
    stderr: "ignore"
  });
  const wslIp = new TextDecoder().decode(wslIpProc.stdout).trim().split(" ")[0];
  if (!wslIp) {
    console.log("     \u2717 Could not determine WSL2 IP address");
    return;
  }
  console.log(`     WSL2 IP: ${wslIp}`);
  console.log(`     Windows will forward port ${fedPort} to WSL2`);
  console.log(`     (This requires Windows admin \u2014 you may see a UAC prompt)`);
  const setupCmd = `Start-Process powershell -ArgumentList '-NoProfile -Command "netsh interface portproxy add v4tov4 listenport=${fedPort} listenaddress=0.0.0.0 connectport=${fedPort} connectaddress=${wslIp}; New-NetFirewallRule -DisplayName Claude-Peers-Federation -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${fedPort} -ErrorAction SilentlyContinue"' -Verb RunAs`;
  const fwdProc = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", setupCmd], {
    stdout: "pipe",
    stderr: "pipe"
  });
  if (fwdProc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(fwdProc.stderr).trim();
    console.log(`     \u26A0 Port forwarding command returned exit code ${fwdProc.exitCode}`);
    if (stderr)
      console.log(`     ${stderr}`);
    console.log(`     You may need to run this manually from an elevated PowerShell:`);
    console.log(`     netsh interface portproxy add v4tov4 listenport=${fedPort} listenaddress=0.0.0.0 connectport=${fedPort} connectaddress=${wslIp}`);
    console.log(`     New-NetFirewallRule -DisplayName Claude-Peers-Federation -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${fedPort}`);
  } else {
    console.log("     \u2713 Port forwarding configured");
  }
  const winIpProc = Bun.spawnSync([
    "powershell.exe",
    "-NoProfile",
    "-Command",
    "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } | Select-Object -First 1 -ExpandProperty IPAddress"
  ], { stdout: "pipe", stderr: "ignore" });
  const windowsLanIp = new TextDecoder().decode(winIpProc.stdout).trim();
  if (windowsLanIp) {
    console.log(`     Your LAN IP: ${windowsLanIp}`);
    console.log("");
    console.log(`     Remote machines can connect with:`);
    console.log(`       bun src/cli.ts federation connect ${windowsLanIp}:${fedPort}`);
  } else {
    console.log("     \u26A0 Could not determine Windows LAN IP");
    console.log("     Check your IP manually: ipconfig (in PowerShell/CMD)");
  }
  console.log("");
  console.log(`  5. To connect to a remote machine:`);
  console.log(`     bun src/cli.ts federation connect <remote-ip>:${fedPort}`);
}
async function federationSetupMacOS(fedPort) {
  console.log("  4. Checking firewall...");
  const fwProc = Bun.spawnSync(["defaults", "read", "/Library/Preferences/com.apple.alf", "globalstate"], { stdout: "pipe", stderr: "ignore" });
  const fwState = new TextDecoder().decode(fwProc.stdout).trim();
  if (fwState === "0") {
    console.log("     \u2713 macOS firewall is off (no action needed)");
  } else {
    console.log("     macOS firewall is on \u2014 ensure Bun is allowed:");
    console.log(`     sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which bun) --unblockapp $(which bun)`);
  }
  const macIpProc = Bun.spawnSync(["ipconfig", "getifaddr", "en0"], {
    stdout: "pipe",
    stderr: "ignore"
  });
  const macIp = new TextDecoder().decode(macIpProc.stdout).trim();
  if (macIp) {
    console.log(`     Your LAN IP: ${macIp}`);
    console.log("");
    console.log(`     Remote machines can connect with:`);
    console.log(`       bun src/cli.ts federation connect ${macIp}:${fedPort}`);
  } else {
    console.log("     \u26A0 Could not determine LAN IP (en0 not active?)");
    console.log("     Check your IP manually: ipconfig getifaddr en0 (or en1 for ethernet)");
  }
  console.log("");
  console.log(`  5. To connect to a remote machine:`);
  console.log(`     bun src/cli.ts federation connect <remote-ip>:${fedPort}`);
}
async function federationSetupLinux(fedPort) {
  console.log("  4. Checking network...");
  const ipProc = Bun.spawnSync(["hostname", "-I"], {
    stdout: "pipe",
    stderr: "ignore"
  });
  const allIps = new TextDecoder().decode(ipProc.stdout).trim().split(/\s+/);
  const lanIp = allIps.find((ip) => ip.startsWith("192.168.") || ip.startsWith("10.")) ?? allIps[0];
  if (lanIp) {
    console.log(`     Your LAN IP: ${lanIp}`);
    console.log("");
    console.log(`     Remote machines can connect with:`);
    console.log(`       bun src/cli.ts federation connect ${lanIp}:${fedPort}`);
    console.log("");
    console.log(`     If connections are refused, check your firewall:`);
    console.log(`       sudo ufw allow ${fedPort}/tcp   # UFW`);
    console.log(`       sudo firewall-cmd --add-port=${fedPort}/tcp --permanent   # firewalld`);
  } else {
    console.log("     \u26A0 Could not determine LAN IP");
    console.log("     Check your IP manually: hostname -I");
  }
  console.log("");
  console.log(`  5. To connect to a remote machine:`);
  console.log(`     bun src/cli.ts federation connect <remote-ip>:${fedPort}`);
}
async function isWSL2() {
  return !!process.env.WSL_DISTRO_NAME || await Bun.file("/proc/sys/fs/binfmt_misc/WSLInterop").exists();
}
async function isWSL2MirroredMode() {
  try {
    const winUser = new TextDecoder().decode(Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", "$env:USERNAME"], { stdout: "pipe", stderr: "ignore" }).stdout).trim();
    if (winUser) {
      const wslConfig = await Bun.file(`/mnt/c/Users/${winUser}/.wslconfig`).text();
      if (/networkingMode\s*=\s*mirrored/i.test(wslConfig))
        return true;
    }
  } catch {}
  return false;
}
async function detectLanIp() {
  if (await isWSL2()) {
    const proc2 = Bun.spawnSync([
      "powershell.exe",
      "-NoProfile",
      "-Command",
      "(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null } | Select-Object -First 1).IPv4Address.IPAddress"
    ], { stdout: "pipe", stderr: "ignore" });
    const ip = new TextDecoder().decode(proc2.stdout).trim();
    if (ip)
      return ip;
    const fallback = Bun.spawnSync([
      "powershell.exe",
      "-NoProfile",
      "-Command",
      "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' -or ($_.IPAddress -like '172.*' -and [int]($_.IPAddress.Split('.')[1]) -ge 16 -and [int]($_.IPAddress.Split('.')[1]) -le 31) } | Select-Object -First 1 -ExpandProperty IPAddress"
    ], { stdout: "pipe", stderr: "ignore" });
    return new TextDecoder().decode(fallback.stdout).trim() || null;
  }
  if (process.platform === "darwin") {
    const proc2 = Bun.spawnSync(["ipconfig", "getifaddr", "en0"], { stdout: "pipe", stderr: "ignore" });
    return new TextDecoder().decode(proc2.stdout).trim() || null;
  }
  const proc = Bun.spawnSync(["hostname", "-I"], { stdout: "pipe", stderr: "ignore" });
  const ips = new TextDecoder().decode(proc.stdout).trim().split(/\s+/);
  return ips.find((ip) => ip.startsWith("192.168.") || ip.startsWith("10.")) ?? ips[0] ?? null;
}
async function refreshWSL2PortForwarding() {
  if (!await isWSL2()) {
    console.error("Error: This command is only for WSL2 environments.");
    process.exit(1);
  }
  if (await isWSL2MirroredMode()) {
    console.log("WSL2 mirrored networking detected \u2014 port forwarding not required.");
    return;
  }
  const config = loadConfig();
  const fedPort = config.federation?.port || parseInt(process.env.CLAUDE_PEERS_FEDERATION_PORT ?? "7900", 10);
  const wslIp = new TextDecoder().decode(Bun.spawnSync(["hostname", "-I"], { stdout: "pipe", stderr: "ignore" }).stdout).trim().split(" ")[0];
  if (!wslIp) {
    console.error("Error: Could not determine WSL2 IP address.");
    process.exit(1);
  }
  const showProc = Bun.spawnSync([
    "powershell.exe",
    "-NoProfile",
    "-Command",
    "netsh interface portproxy show v4tov4"
  ], { stdout: "pipe", stderr: "ignore" });
  const rules = new TextDecoder().decode(showProc.stdout);
  const portRegex = new RegExp(`0\\.0\\.0\\.0\\s+${fedPort}\\s+(\\S+)\\s+${fedPort}`, "m");
  const match = rules.match(portRegex);
  if (match) {
    const currentTarget = match[1];
    if (currentTarget === wslIp) {
      console.log(`Port forwarding is current (port ${fedPort} \u2192 ${wslIp})`);
      return;
    }
    console.log(`Stale portproxy detected: port ${fedPort} \u2192 ${currentTarget} (should be ${wslIp})`);
    console.log("Updating...");
  } else {
    console.log(`No portproxy rule for port ${fedPort}. Creating...`);
  }
  const updateCmd = `Start-Process powershell -ArgumentList '-NoProfile -Command "netsh interface portproxy delete v4tov4 listenport=${fedPort} listenaddress=0.0.0.0 2>$null; netsh interface portproxy add v4tov4 listenport=${fedPort} listenaddress=0.0.0.0 connectport=${fedPort} connectaddress=${wslIp}"' -Verb RunAs -Wait`;
  Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", updateCmd], { stdout: "ignore", stderr: "ignore" });
  await new Promise((r) => setTimeout(r, 1000));
  const verifyProc = Bun.spawnSync([
    "powershell.exe",
    "-NoProfile",
    "-Command",
    "netsh interface portproxy show v4tov4"
  ], { stdout: "pipe", stderr: "ignore" });
  const verifyRules = new TextDecoder().decode(verifyProc.stdout);
  const verifyMatch = verifyRules.match(portRegex);
  if (verifyMatch && verifyMatch[1] === wslIp) {
    console.log(`OK  Port forwarding updated (port ${fedPort} \u2192 ${wslIp})`);
  } else {
    console.log(`WARN  Could not verify port forwarding update. You may need admin elevation.`);
    console.log(`Manual fix: Run in elevated PowerShell:`);
    console.log(`  netsh interface portproxy add v4tov4 listenport=${fedPort} listenaddress=0.0.0.0 connectport=${fedPort} connectaddress=${wslIp}`);
  }
}
async function federationInit() {
  const isWSL2Flag = await isWSL2();
  const isMac = process.platform === "darwin";
  const platform = isWSL2Flag ? "WSL2" : isMac ? "macOS" : "Linux";
  const fedPort = parseInt(process.env.CLAUDE_PEERS_FEDERATION_PORT ?? "7900", 10);
  console.log(`
[Federation Init \u2014 ${platform} Detected]
`);
  let step = 1;
  const existingConfig = loadConfig();
  const subnet = isWSL2Flag ? "0.0.0.0/0" : existingConfig.federation?.subnet || "0.0.0.0/0";
  const newConfig = {
    ...existingConfig,
    federation: {
      ...existingConfig.federation,
      enabled: true,
      port: fedPort,
      subnet
    }
  };
  writeConfig(newConfig);
  console.log(`  ${step++}. OK  Config file written (${CONFIG_PATH})`);
  try {
    await ensureTlsCert();
    console.log(`  ${step++}. OK  TLS certificate ready`);
  } catch (e) {
    console.log(`  ${step++}. FAIL  TLS certificate: ${e instanceof Error ? e.message : String(e)}`);
  }
  const tokenExists = await Bun.file(TOKEN_PATH).exists();
  if (tokenExists) {
    console.log(`  ${step++}. OK  Auth token ready (${TOKEN_PATH})`);
  } else {
    console.log(`  ${step++}. OK  Auth token will be created on broker start`);
  }
  if (isWSL2Flag) {
    if (await isWSL2MirroredMode()) {
      console.log(`  ${step++}. OK  WSL2 mirrored networking detected \u2014 port forwarding not required`);
      step++;
    } else {
      await federationSetupWSL2(fedPort);
      step += 2;
    }
  } else if (isMac) {
    await federationSetupMacOS(fedPort);
    step += 2;
  } else {
    await federationSetupLinux(fedPort);
    step += 2;
  }
  try {
    await brokerFetch("/health");
    const killProc = Bun.spawnSync(["pkill", "-f", "bun.*src/broker.ts"], { stdout: "ignore", stderr: "ignore" });
    console.log(`  ${step++}. OK  Broker restarted with federation enabled`);
  } catch {
    console.log(`  ${step++}. OK  Broker not running (will start with federation on next session)`);
  }
  const lanIp = await detectLanIp();
  if (lanIp && tokenExists) {
    try {
      const token = readTokenSync();
      const encodedToken = Buffer.from(token).toString("base64url");
      const joinUrl = `cpt://${lanIp}:${fedPort}/${encodedToken}`;
      console.log(`
Your LAN IP: ${lanIp}`);
      console.log(`
To connect another machine, run this on the remote:`);
      console.log(`  bun src/cli.ts federation join ${joinUrl}`);
      console.log(`
\u26A0  This URL contains your federation token. Share it only with trusted machines on your LAN.`);
    } catch {
      console.log(`
Your LAN IP: ${lanIp}`);
      console.log(`
Generate a join URL: bun src/cli.ts federation token`);
    }
  } else if (lanIp) {
    console.log(`
Your LAN IP: ${lanIp}`);
    console.log(`After broker starts, generate a join URL: bun src/cli.ts federation token`);
  }
  console.log("");
}
async function federationToken() {
  const config = loadConfig();
  const fedPort = config.federation?.port || parseInt(process.env.CLAUDE_PEERS_FEDERATION_PORT ?? "7900", 10);
  const lanIp = await detectLanIp();
  if (!lanIp) {
    console.error("Error: Could not detect LAN IP. Specify manually with: CLAUDE_PEERS_LAN_IP=x.x.x.x bun src/cli.ts federation token");
    process.exit(1);
  }
  let token;
  try {
    token = readTokenSync();
  } catch {
    console.error(`Error: Token file not found at ${TOKEN_PATH}. Run 'federation init' first.`);
    process.exit(1);
  }
  const encodedToken = Buffer.from(token).toString("base64url");
  const joinUrl = `cpt://${lanIp}:${fedPort}/${encodedToken}`;
  console.log(joinUrl);
  console.error(`
\u26A0  This URL contains your federation token. Share it only with trusted machines on your LAN.`);
}
async function federationJoin(cptUrl) {
  if (!cptUrl.startsWith("cpt://")) {
    console.error(`Error: Invalid URL format. Expected cpt://<host>:<port>/<token>`);
    process.exit(1);
  }
  const remainder = cptUrl.slice(6);
  const slashIdx = remainder.indexOf("/", remainder.indexOf(":") + 1);
  if (slashIdx === -1) {
    console.error(`Error: Invalid URL format. Expected cpt://<host>:<port>/<token>`);
    process.exit(1);
  }
  const hostPort = remainder.slice(0, slashIdx);
  const encodedToken = remainder.slice(slashIdx + 1);
  const colonIdx = hostPort.lastIndexOf(":");
  const host = hostPort.slice(0, colonIdx);
  const port = parseInt(hostPort.slice(colonIdx + 1), 10);
  if (!host || isNaN(port)) {
    console.error(`Error: Could not parse host:port from "${hostPort}"`);
    process.exit(1);
  }
  let token;
  try {
    token = Buffer.from(encodedToken, "base64url").toString("utf-8");
  } catch {
    console.error(`Error: Could not decode token from URL`);
    process.exit(1);
  }
  console.log(`[Federation Join]
`);
  const existingToken = await Bun.file(TOKEN_PATH).exists();
  if (existingToken) {
    const current = readTokenSync();
    if (current !== token) {
      console.log(`  \u26A0  Token file already exists with a different token.`);
      console.log(`  Overwriting with the new token from the join URL.`);
    }
  }
  fs3.writeFileSync(TOKEN_PATH, token + `
`, { mode: 384 });
  console.log(`  1. OK  Token written to ${TOKEN_PATH}`);
  const config = loadConfig();
  const fedPort = config.federation?.port || 7900;
  writeConfig({
    ...config,
    federation: {
      ...config.federation,
      enabled: true,
      port: fedPort,
      remotes: [
        ...(config.federation?.remotes ?? []).filter((r) => `${r.host}:${r.port}` !== `${host}:${port}`),
        { host, port }
      ]
    }
  });
  console.log(`  2. OK  Config updated (federation enabled, remote added)`);
  try {
    await ensureTlsCert();
    console.log(`  3. OK  TLS certificate ready`);
  } catch (e) {
    console.log(`  3. FAIL  TLS certificate: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    Bun.spawnSync(["pkill", "-f", "bun.*src/broker.ts"], { stdout: "ignore", stderr: "ignore" });
    console.log(`  4. OK  Broker restarted`);
  } catch {
    console.log(`  4. OK  Broker not running (will start on next session)`);
  }
  console.log(`  5. Connecting to ${host}:${port}...`);
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const result = await brokerFetch("/federation/connect", { host, port });
    if (result.ok) {
      console.log(`     OK  Connected to ${result.hostname ?? host}`);
    } else {
      console.log(`     \u26A0  Connection attempt failed: ${result.error}`);
      console.log(`     The broker will auto-reconnect on next restart.`);
    }
  } catch {
    console.log(`     \u26A0  Broker not ready yet. Auto-reconnect will handle it on next startup.`);
  }
  console.log("");
}
async function federationDoctor() {
  let passed = 0;
  let failed = 0;
  let warnings = 0;
  function ok(msg) {
    console.log(`  OK   ${msg}`);
    passed++;
  }
  function fail(msg, fix) {
    console.log(`  FAIL ${msg}`);
    if (fix)
      console.log(`       Fix: ${fix}`);
    failed++;
  }
  function warn(msg, fix) {
    console.log(`  WARN ${msg}`);
    if (fix)
      console.log(`       Fix: ${fix}`);
    warnings++;
  }
  console.log(`
Federation Health Check
${"=".repeat(23)}
`);
  const config = loadConfig();
  if (Object.keys(config).length > 0) {
    ok(`Config file (${CONFIG_PATH})`);
  } else {
    fail(`Config file missing or empty`, `bun src/cli.ts federation init`);
  }
  const fedEnabled = process.env.CLAUDE_PEERS_FEDERATION_ENABLED === "true" || config.federation?.enabled === true;
  if (fedEnabled) {
    const source = process.env.CLAUDE_PEERS_FEDERATION_ENABLED === "true" ? "env var" : "config file";
    ok(`Federation enabled (source: ${source})`);
  } else {
    fail(`Federation not enabled`, `bun src/cli.ts federation enable`);
  }
  const tokenExists = await Bun.file(TOKEN_PATH).exists();
  if (tokenExists) {
    ok(`Auth token (${TOKEN_PATH})`);
  } else {
    fail(`Auth token missing`, `bun src/cli.ts rotate-token`);
  }
  const certPath = `${process.env.HOME}/.claude-peers-federation.crt`;
  const certExists = await Bun.file(certPath).exists();
  if (certExists) {
    ok(`TLS certificate (${certPath})`);
  } else {
    fail(`TLS certificate missing`, `bun src/cli.ts federation init`);
  }
  let brokerOk = false;
  let peerCount = 0;
  try {
    const health = await fetch("http://127.0.0.1:7899/health", { signal: AbortSignal.timeout(2000) });
    if (health.ok) {
      const data = await health.json();
      peerCount = data.peers;
      ok(`Broker running (${peerCount} local peers)`);
      brokerOk = true;
    } else {
      fail(`Broker returned HTTP ${health.status}`, `bun src/cli.ts kill-broker`);
    }
  } catch {
    fail(`Broker not running`, `Start a Claude Code session or run: bun src/broker.ts`);
  }
  if (brokerOk) {
    try {
      const status = await brokerFetch("/federation/status");
      if (status.enabled) {
        ok(`Federation TLS listening on port ${status.port}`);
        if (status.remotes.length > 0) {
          for (const r of status.remotes) {
            ok(`Remote: ${r.hostname} (${r.host}:${r.port}) \u2014 ${r.peer_count} peer(s)`);
          }
        }
        const connectedKeys = new Set(status.remotes.map((r) => `${r.host}:${r.port}`));
        for (const saved of config.federation?.remotes ?? []) {
          const key = `${saved.host}:${saved.port}`;
          if (!connectedKeys.has(key)) {
            warn(`Config has remote ${key} but it's not currently connected`, `bun src/cli.ts federation connect ${key}`);
          }
        }
      } else {
        fail(`Federation TLS not listening`, `Restart broker: bun src/cli.ts kill-broker`);
      }
    } catch {
      fail(`Could not query federation status`);
    }
  }
  const lanIp = await detectLanIp();
  if (lanIp) {
    ok(`LAN IP detected: ${lanIp}`);
  } else {
    warn(`Could not detect LAN IP`);
  }
  console.log(`
${passed} passed, ${failed} failed, ${warnings} warning(s)
`);
  if (failed > 0)
    process.exit(1);
}
if (Bun.main === import.meta.path) {
  const cmd = process.argv[2];
  if (cmd !== "rotate-token") {
    try {
      authToken = readTokenSync();
    } catch {}
  }
  switch (cmd) {
    case "status": {
      try {
        const health = await brokerFetch("/health");
        console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
        console.log(`URL: ${BROKER_URL}`);
        if (health.peers > 0) {
          const peers = await brokerFetch("/list-peers", {
            scope: "machine",
            cwd: "/",
            git_root: null
          });
          console.log(`
Peers:`);
          for (const p of peers) {
            const nameTag = p.session_name ? ` [${p.session_name}]` : "";
            console.log(`  ${p.id}${nameTag}  PID:${p.pid}  ${p.cwd}`);
            if (p.summary)
              console.log(`         ${p.summary}`);
            if (p.tty)
              console.log(`         TTY: ${p.tty}`);
            console.log(`         Last seen: ${p.last_seen}`);
          }
        }
      } catch {
        console.log("Broker is not running.");
      }
      break;
    }
    case "peers": {
      try {
        const peers = await brokerFetch("/list-peers", {
          scope: "machine",
          cwd: "/",
          git_root: null
        });
        if (peers.length === 0) {
          console.log("No peers registered.");
        } else {
          for (const p of peers) {
            const nameTag = p.session_name ? ` [${p.session_name}]` : "";
            const parts = [`${p.id}${nameTag}  PID:${p.pid}  ${p.cwd}`];
            if (p.summary)
              parts.push(`  Summary: ${p.summary}`);
            console.log(parts.join(`
`));
          }
        }
      } catch {
        console.log("Broker is not running.");
      }
      break;
    }
    case "send": {
      const toId = process.argv[3];
      const msg = process.argv.slice(4).join(" ");
      if (!toId || !msg) {
        console.error("Usage: bun cli.ts send <peer-id> <message>");
        process.exit(1);
      }
      try {
        const result = await brokerFetch("/send-message", {
          from_id: "cli",
          to_id: toId,
          text: msg
        });
        if (result.ok) {
          console.log(`Message sent to ${toId} (msg#${result.message_id}, type: text)`);
        } else {
          console.error(`Failed: ${result.error}`);
        }
      } catch (e) {
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    }
    case "broadcast": {
      const scope = process.argv[3];
      const msg = process.argv.slice(4).join(" ");
      if (!scope || !msg || !["machine", "directory", "repo"].includes(scope)) {
        console.error("Usage: bun cli.ts broadcast <machine|directory|repo> <message>");
        process.exit(1);
      }
      const cwd = process.cwd();
      let gitRoot = null;
      try {
        const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
          cwd,
          stdout: "pipe",
          stderr: "ignore"
        });
        if (proc.exitCode === 0) {
          gitRoot = new TextDecoder().decode(proc.stdout).trim() || null;
        }
      } catch {}
      try {
        const result = await brokerFetch("/broadcast", {
          from_id: "cli",
          text: msg,
          type: "broadcast",
          scope,
          cwd,
          git_root: gitRoot
        });
        if (!result.ok) {
          console.error(`Failed: ${result.error}`);
        } else if (result.recipients === 0) {
          console.log(`No peers in scope '${scope}'`);
        } else {
          console.log(`Broadcast sent to ${result.recipients} peer(s)`);
        }
      } catch (e) {
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    }
    case "set-name": {
      const peerId = process.argv[3];
      const name = process.argv.slice(4).join(" ");
      if (!peerId || !name) {
        console.error("Usage: bun cli.ts set-name <peer-id> <name>");
        process.exit(1);
      }
      try {
        const result = await brokerFetch("/set-name", {
          id: peerId,
          session_name: name
        });
        if (result.ok) {
          console.log(`Session name set for ${peerId}: "${name}"`);
        } else {
          console.error("Failed to set session name.");
        }
      } catch (e) {
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    }
    case "auto-summary": {
      const peerId = process.argv[3];
      if (!peerId) {
        console.error("Usage: bun cli.ts auto-summary <peer-id>");
        process.exit(1);
      }
      const cwd = process.cwd();
      const repoName = getGitRepoName(cwd);
      const branch = getGitBranchName(cwd);
      const taskCount = await getTaskMasterInProgress(cwd);
      const summary = buildSummary({ repoName, branch, cwd, taskCount });
      console.log(summary);
      try {
        const result = await brokerFetch("/set-summary", {
          id: peerId,
          summary
        });
        if (!result.ok) {
          console.error("Error: Broker returned failure for /set-summary.");
          process.exit(1);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("fetch") || msg.includes("ECONNREFUSED") || msg.includes("ConnectionRefused") || msg.includes("Unable to connect")) {
          console.error(`Error: Broker not reachable at ${BROKER_URL}. Is it running?`);
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exit(1);
      }
      break;
    }
    case "rotate-token": {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const newToken = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
      fs3.writeFileSync(TOKEN_PATH, newToken + `
`, { mode: 384 });
      console.log(`Token rotated. New token written to ${TOKEN_PATH}. Broker will pick it up within 60 seconds.`);
      break;
    }
    case "restart": {
      console.log("Killing all claude-peers processes (broker + MCP servers)...");
      try {
        const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
        const pids = new TextDecoder().decode(proc.stdout).trim().split(`
`).filter((p) => p);
        for (const pid of pids) {
          try {
            process.kill(parseInt(pid), "SIGTERM");
          } catch {}
        }
      } catch {}
      console.log("Broker killed. MCP servers will exit when their sessions reconnect.");
      console.log("Run /mcp in each Claude Code session to reconnect.");
      break;
    }
    case "kill-broker": {
      try {
        const health = await brokerFetch("/health");
        console.log(`Broker has ${health.peers} peer(s). Shutting down...`);
        const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
        const pids = new TextDecoder().decode(proc.stdout).trim().split(`
`).filter((p) => p);
        for (const pid of pids) {
          process.kill(parseInt(pid), "SIGTERM");
        }
        console.log("Broker stopped.");
      } catch {
        console.log("Broker is not running.");
      }
      break;
    }
    case "reload-broker": {
      try {
        const health = await brokerFetch("/health");
        const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
        const pids = new TextDecoder().decode(proc.stdout).trim().split(`
`).filter((p) => p);
        if (pids.length === 0) {
          console.log("Broker PID not found.");
          break;
        }
        for (const pid of pids) {
          process.kill(parseInt(pid), "SIGHUP");
        }
        console.log(`Broker hot-reloaded (SIGHUP sent). ${health.peers} peer(s) stay connected.`);
      } catch {
        console.log("Broker is not running.");
      }
      break;
    }
    case "federation": {
      const subCmd = process.argv[3];
      switch (subCmd) {
        case "connect": {
          const target = process.argv[4];
          if (!target || !target.includes(":")) {
            console.error("Usage: bun cli.ts federation connect <host>:<port>");
            process.exit(1);
          }
          const lastColon = target.lastIndexOf(":");
          const host = target.slice(0, lastColon);
          const port = parseInt(target.slice(lastColon + 1), 10);
          if (isNaN(port) || port <= 0 || port > 65535) {
            console.error(`Invalid port in "${target}". Expected <host>:<port>.`);
            process.exit(1);
          }
          try {
            const result = await brokerFetch("/federation/connect", { host, port });
            if (result.ok) {
              const remoteName = result.hostname ?? host;
              const peerCount = result.peer_count ?? 0;
              console.log(`Connected to ${host}:${port} (${remoteName}). ${peerCount} remote peer${peerCount === 1 ? "" : "s"} available.`);
            } else {
              console.error(`Failed: ${result.error ?? "Unknown error"}`);
              process.exit(1);
            }
          } catch (e) {
            console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
            process.exit(1);
          }
          break;
        }
        case "disconnect": {
          const target = process.argv[4];
          if (!target || !target.includes(":")) {
            console.error("Usage: bun cli.ts federation disconnect <host>:<port>");
            process.exit(1);
          }
          const lastColon = target.lastIndexOf(":");
          const host = target.slice(0, lastColon);
          const port = parseInt(target.slice(lastColon + 1), 10);
          if (isNaN(port) || port <= 0 || port > 65535) {
            console.error(`Invalid port in "${target}". Expected <host>:<port>.`);
            process.exit(1);
          }
          try {
            const result = await brokerFetch("/federation/disconnect", { host, port });
            if (result.ok) {
              console.log(`Disconnected from ${host}:${port}.`);
            } else {
              console.error(`Failed: ${result.error ?? "Unknown error"}`);
              process.exit(1);
            }
          } catch (e) {
            console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
            process.exit(1);
          }
          break;
        }
        case "status": {
          try {
            const status = await brokerFetch("/federation/status");
            if (!status.enabled) {
              console.log("Federation is disabled. Set CLAUDE_PEERS_FEDERATION_ENABLED=true to enable.");
              break;
            }
            if (status.remotes.length === 0) {
              console.log(`Federation enabled on port ${status.port}. No remote machines connected.`);
              break;
            }
            console.log(`Federation enabled on port ${status.port} (subnet: ${status.subnet})`);
            console.log(`
Connected remotes (${status.remotes.length}):`);
            for (const r of status.remotes) {
              const uptime = formatUptime(r.connected_at);
              console.log(`  ${r.host}:${r.port}  hostname=${r.hostname}  peers=${r.peer_count}  uptime=${uptime}`);
            }
            console.log(`
Total remote peers: ${status.total_remote_peers}`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("fetch") || msg.includes("ECONNREFUSED") || msg.includes("ConnectionRefused") || msg.includes("Unable to connect")) {
              console.log("Broker is not running.");
            } else {
              console.error(`Error: ${msg}`);
            }
          }
          break;
        }
        case "setup":
        case "init": {
          await federationInit();
          break;
        }
        case "token": {
          await federationToken();
          break;
        }
        case "join": {
          const joinUrl = process.argv[4];
          if (!joinUrl) {
            console.error("Usage: bun cli.ts federation join cpt://<host>:<port>/<token>");
            process.exit(1);
          }
          await federationJoin(joinUrl);
          break;
        }
        case "doctor": {
          await federationDoctor();
          break;
        }
        case "refresh-wsl2": {
          await refreshWSL2PortForwarding();
          break;
        }
        case "enable": {
          const existingConfig = loadConfig();
          const port = parseInt(process.argv[4] || "") || existingConfig.federation?.port || 7900;
          const subnet = process.argv[5] || existingConfig.federation?.subnet || "0.0.0.0/0";
          const newConfig = {
            ...existingConfig,
            federation: { enabled: true, port, subnet }
          };
          writeConfig(newConfig);
          console.log(`Federation enabled in config file.`);
          console.log(`  Config: ${CONFIG_PATH}`);
          console.log(`  Port: ${port}`);
          console.log(`  Subnet: ${subnet}`);
          console.log(`
Restart the broker to apply: bun src/cli.ts kill-broker`);
          break;
        }
        case "disable": {
          const existingConfig = loadConfig();
          const newConfig = {
            ...existingConfig,
            federation: {
              ...existingConfig.federation,
              enabled: false
            }
          };
          writeConfig(newConfig);
          console.log(`Federation disabled in config file.`);
          console.log(`  Config: ${CONFIG_PATH}`);
          console.log(`
Restart the broker to apply: bun src/cli.ts kill-broker`);
          break;
        }
        default:
          console.error(`Unknown federation subcommand: ${subCmd ?? "(none)"}`);
          console.error("Usage: bun cli.ts federation <init|join|connect|disconnect|status|doctor|token|enable|disable> [args]");
          process.exit(1);
      }
      break;
    }
    case "metrics": {
      try {
        const detailed = process.argv[3] === "--detailed";
        const metricsUrl = detailed ? "/metrics?detailed=true" : "/metrics";
        const metrics = await brokerFetch(metricsUrl);
        console.log(`
  Broker Metrics:
`);
        console.log(`    Uptime:              ${formatUptime(new Date(Date.now() - metrics.uptime_seconds * 1000).toISOString())}`);
        console.log(`    Peers:               ${metrics.peer_count}`);
        console.log(`    Requests/min:        ${metrics.requests_per_minute}`);
        console.log(`
  Messages:`);
        console.log(`    Total:               ${metrics.messages.total}`);
        console.log(`    Delivered:           ${metrics.messages.delivered}`);
        console.log(`    Pending:             ${metrics.messages.pending}`);
        console.log(`    Delivery rate:       ${metrics.messages.delivery_rate_pct}%`);
        console.log(`
  Federation:`);
        console.log(`    Enabled:             ${metrics.federation.enabled}`);
        console.log(`    Remote machines:     ${metrics.federation.remote_count}`);
        console.log(`    Remote peers:        ${metrics.federation.remote_peer_count}`);
        if (detailed && metrics.peers) {
          console.log(`
  Peers (detailed):`);
          for (const p of metrics.peers) {
            console.log(`    ${p.name} (${p.id})`);
            console.log(`      cwd: ${p.cwd}`);
            console.log(`      push: ${p.channel_push}  last_seen: ${p.last_seen}`);
          }
        }
        console.log("");
      } catch (e) {
        console.error(`Failed to fetch metrics: ${e instanceof Error ? e.message : e}`);
        process.exit(1);
      }
      break;
    }
    case "messages": {
      const { Database } = await import("bun:sqlite");
      const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
      if (!fs3.existsSync(DB_PATH)) {
        console.error(`Database not found: ${DB_PATH}`);
        process.exit(1);
      }
      const msgDb = new Database(DB_PATH, { readonly: true });
      const args = process.argv.slice(3);
      let fromFilter = "";
      let toFilter = "";
      let sinceFilter = "";
      let searchFilter = "";
      let limit = 20;
      let jsonOutput = false;
      for (let i = 0;i < args.length; i++) {
        switch (args[i]) {
          case "--from":
            fromFilter = args[++i] || "";
            break;
          case "--to":
            toFilter = args[++i] || "";
            break;
          case "--since":
            sinceFilter = args[++i] || "";
            break;
          case "--search":
            searchFilter = args[++i] || "";
            break;
          case "--limit":
            limit = parseInt(args[++i]) || 20;
            break;
          case "--json":
            jsonOutput = true;
            break;
        }
      }
      const conditions = [];
      const params = [];
      if (fromFilter) {
        conditions.push("from_id LIKE ?");
        params.push(`%${fromFilter}%`);
      }
      if (toFilter) {
        conditions.push("to_id LIKE ?");
        params.push(`%${toFilter}%`);
      }
      if (sinceFilter) {
        conditions.push("sent_at >= ?");
        params.push(sinceFilter);
      }
      if (searchFilter) {
        conditions.push("text LIKE ?");
        params.push(`%${searchFilter}%`);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const query = `SELECT id, from_id, to_id, text, type, sent_at, delivered FROM messages ${where} ORDER BY sent_at DESC LIMIT ?`;
      params.push(String(limit));
      const messages = msgDb.query(query).all(...params);
      if (jsonOutput) {
        console.log(JSON.stringify(messages, null, 2));
      } else {
        if (messages.length === 0) {
          console.log("No messages found.");
        } else {
          console.log(`
  Messages (${messages.length} result${messages.length === 1 ? "" : "s"}):
`);
          for (const m of messages) {
            const status = m.delivered ? "delivered" : "pending";
            const time = m.sent_at.replace("T", " ").replace(/\.\d+Z$/, "");
            console.log(`  #${m.id}  ${time}  [${m.type}] ${status}`);
            console.log(`    From: ${m.from_id}  \u2192  To: ${m.to_id}`);
            const preview = m.text.length > 120 ? m.text.slice(0, 120) + "..." : m.text;
            console.log(`    ${preview}`);
            console.log("");
          }
        }
      }
      msgDb.close();
      break;
    }
    default:
      console.log(`claude-peers CLI

Usage:
  bun cli.ts status                                Show broker status and all peers
  bun cli.ts peers                                 List all peers
  bun cli.ts send <id> <msg>                       Send a message to a peer
  bun cli.ts broadcast <scope> <msg>               Broadcast to all peers in scope (machine/directory/repo)
  bun cli.ts set-name <id> <name>                  Set a peer's session name
  bun cli.ts auto-summary <id>                     Generate and set a deterministic summary
  bun cli.ts rotate-token                          Rotate the auth token
  bun cli.ts restart                               Kill ALL claude-peers processes (broker + servers)
  bun cli.ts kill-broker                           Stop the broker daemon
  bun cli.ts reload-broker                         Hot-reload broker config (SIGHUP, no restart)
  bun cli.ts messages [--from X] [--to X] [--json] Search message history
  bun cli.ts metrics [--detailed]                  Show broker metrics

Federation:
  bun cli.ts federation init                       One-command federation setup (config, certs, firewall)
  bun cli.ts federation join <cpt-url>             Join a federation using a cpt:// URL from another machine
  bun cli.ts federation token                      Generate a cpt:// URL for other machines to join
  bun cli.ts federation doctor                     Diagnose federation health (checks all prerequisites)
  bun cli.ts federation connect <host>:<port>      Connect to a remote broker (persists to config)
  bun cli.ts federation disconnect <host>:<port>   Disconnect from a remote broker (removes from config)
  bun cli.ts federation status                     Show federation status
  bun cli.ts federation refresh-wsl2                Update WSL2 port forwarding if IP changed
  bun cli.ts federation enable [port] [subnet]     Enable federation in config file
  bun cli.ts federation disable                    Disable federation in config file`);
  }
}
export {
  getTaskMasterInProgress,
  getGitRepoName,
  getGitBranchName,
  formatUptime,
  buildSummary
};
