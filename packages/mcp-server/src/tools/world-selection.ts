/**
 * World selection tools
 *
 * More than one Foundry world can be open at once (for example a hosted world and a
 * local copy), and every one of them connects to this server. Exactly one is "active"
 * and receives Claude's queries:
 *
 *   - list-foundry-worlds:  which worlds are connected, and which is active
 *   - select-foundry-world: switch the active world
 *
 * The first world to connect stays active until one is selected, so a second world being
 * opened never silently takes over.
 */

import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface WorldSelectionToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const listSchema = z.object({}).strict();
const selectSchema = z.object({ world: z.string().min(1) }).strict();

export class WorldSelectionTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: WorldSelectionToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WorldSelectionTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'list-foundry-worlds',
        description:
          'List every Foundry world currently connected to the MCP server and show which one is ' +
          'ACTIVE (the one all other tools talk to). More than one world can be open at once, ' +
          'for example a hosted world and a local copy, so check this when results look like they ' +
          'come from the wrong world or a recently added tool is "not found". Each entry shows ' +
          'its title, system, module version and connection id. A world on an older module may ' +
          'show without a module version or tool count.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'select-foundry-world',
        description:
          'Switch which connected Foundry world the other tools talk to. Identify it by world ' +
          'title, world id, or the connection id from list-foundry-worlds (use the connection id ' +
          'when two worlds share a title, or a fragment of the address such as "localhost"). The ' +
          'first world to connect stays active until you switch. Your choice is remembered: that ' +
          'world is put back in charge when it reconnects after a page reload or a server restart. ' +
          'Affects every tool until changed again.',
        inputSchema: {
          type: 'object',
          properties: {
            world: {
              type: 'string',
              description: 'World title, world id, or connection id (for example "c2").',
            },
          },
          required: ['world'],
        },
      },
    ];
  }

  async handleListWorlds(args: unknown) {
    const parsed = listSchema.safeParse(args ?? {});
    if (!parsed.success) return invalidArgs(parsed.error);

    try {
      const worlds = await this.foundryClient.listWorlds();
      const active = worlds.find(w => w.active) ?? null;
      return {
        success: true,
        count: worlds.length,
        active: active ? `${active.label} (${active.connectionId})` : null,
        worlds,
        ...(worlds.length === 0
          ? {
              note:
                'No Foundry world is connected. Open a world with the Foundry MCP Bridge module ' +
                'enabled, or check its Connection Status panel.',
            }
          : {}),
        ...(worlds.length > 1
          ? {
              note:
                'More than one world is connected. Queries go to the active one; use ' +
                'select-foundry-world to switch.',
            }
          : {}),
      };
    } catch (error) {
      this.logger.error('Failed to list worlds', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async handleSelectWorld(args: unknown) {
    const parsed = selectSchema.safeParse(args ?? {});
    if (!parsed.success) return invalidArgs(parsed.error);

    this.logger.info('Selecting Foundry world', { world: parsed.data.world });
    try {
      // Names are only known once each world has announced itself, so make sure they have.
      await this.foundryClient.listWorlds();
      const selected = this.foundryClient.selectWorld(parsed.data.world);
      const remembered = selected.preferred
        ? 'This choice is remembered across reloads and restarts.'
        : 'This world cannot be remembered across reloads (its module is too old to say where it is open).';
      return {
        success: true,
        active: selected,
        message: `Now talking to "${selected.label}" (${selected.connectionId}). ${remembered}`,
        worlds: await this.foundryClient.listWorlds(),
      };
    } catch (error) {
      this.logger.error('Failed to select world', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}

function invalidArgs(error: z.ZodError) {
  const detail = error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return { success: false, error: `Invalid arguments: ${detail}` };
}
