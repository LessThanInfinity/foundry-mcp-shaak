/**
 * Remembers which Foundry world the user last chose to talk to, between runs of the server,
 * so a restart (or a rebuild) puts that world back in charge when it reconnects.
 *
 * Stored as a tiny JSON file in the user's home folder. Every failure is swallowed: losing
 * the preference only means the first world to connect is active again, which is the
 * default behaviour.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface PreferredWorldStore {
  load(): string | null;
  save(key: string | null): void;
}

/** ~/.foundry-mcp/preferred-world.json, or $FOUNDRY_MCP_STATE_DIR/preferred-world.json. */
export function defaultPreferredWorldPath(): string {
  const dir = process.env.FOUNDRY_MCP_STATE_DIR || path.join(os.homedir(), '.foundry-mcp');
  return path.join(dir, 'preferred-world.json');
}

export class FilePreferredWorldStore implements PreferredWorldStore {
  constructor(private file: string = defaultPreferredWorldPath()) {}

  load(): string | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as {
        preferredWorld?: unknown;
      } | null;
      const value = parsed?.preferredWorld;
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  save(key: string | null): void {
    try {
      if (key === null) {
        fs.rmSync(this.file, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ preferredWorld: key }, null, 2));
    } catch {
      // not being able to remember is not worth failing a world switch over
    }
  }
}
