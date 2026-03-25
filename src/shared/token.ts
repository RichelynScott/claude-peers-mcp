/**
 * Shared token helper for claude-peers authentication.
 *
 * Used by server.ts and cli.ts to read the broker auth token.
 */
import * as fs from "node:fs";

export const TOKEN_PATH =
  process.env.CLAUDE_PEERS_TOKEN ?? `${process.env.HOME}/.claude-peers-token`;

/**
 * Read the auth token from the token file.
 * Returns the trimmed hex string.
 * Throws if the file does not exist or is empty.
 */
export function readTokenSync(): string {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`Token file not found at ${TOKEN_PATH}`);
  }
  const content = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
  if (!content) {
    throw new Error(`Token file is empty at ${TOKEN_PATH}`);
  }
  return content;
}
