/**
 * Module Data Tools
 *
 * Generic read/write access to the data other modules keep in Foundry:
 *   - manage-flags:            document flags (flags.<scope>.<key>) on actors,
 *                              items, scenes, journals, users, ...
 *   - manage-module-settings:  a module's registered settings
 *
 * Lets Claude inspect and configure any installed module without a
 * module-specific tool. Foundry's own "core" scope is off-limits.
 */

import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface ModuleDataToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const scopeSchema = z
  .string()
  .min(1)
  .refine(s => s !== 'core', { message: 'the "core" scope is not accessible' });

const manageFlagsSchema = z
  .object({
    action: z.enum(['get', 'set', 'unset']),
    uuid: z.string().min(1).optional(),
    actor: z.string().min(1).optional(),
    scope: scopeSchema,
    key: z.string().min(1).optional(),
    value: z.unknown().optional(),
    replace: z.boolean().optional(),
  })
  .strict()
  .refine(d => d.uuid || d.actor, { message: 'Provide "uuid" or "actor"' })
  .refine(d => d.action === 'get' || d.key, { message: '"key" is required for set and unset' })
  .refine(d => d.action !== 'set' || d.value !== undefined, {
    message: '"value" is required for set',
  });

const manageSettingsSchema = z
  .object({
    action: z.enum(['list', 'get', 'set']),
    scope: scopeSchema,
    key: z.string().min(1).optional(),
    value: z.unknown().optional(),
  })
  .strict()
  .refine(d => d.action === 'list' || d.key, { message: '"key" is required for get and set' })
  .refine(d => d.action !== 'set' || d.value !== undefined, {
    message: '"value" is required for set',
  });

export class ModuleDataTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: ModuleDataToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'ModuleDataTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'manage-flags',
        description:
          'Read or write module data stored as flags on a Foundry document (flags.<scope>.<key>). ' +
          'Use this to inspect or configure other modules that keep per-document data, e.g. ' +
          'cut-in presets and triggers on an actor. Target the document by "uuid" (e.g. ' +
          '"Actor.abc123", "Actor.abc123.Item.def456", "Scene.xyz", "JournalEntry.qrs") or, for ' +
          'actors, by "actor" name or id.\n' +
          '- "get": return flags.<scope> (or flags.<scope>.<key> if key is given). Read-only.\n' +
          '- "set": write value at flags.<scope>.<key> (key may be a dot path). Objects are ' +
          'deep-MERGED into what is there and arrays are replaced; pass "replace": true to ' +
          'overwrite the key entirely. GM-only, needs Allow Write Operations.\n' +
          '- "unset": delete flags.<scope>.<key>. GM-only, needs Allow Write Operations.\n' +
          'Always "get" first and change only what you need; other modules rely on this data ' +
          "being in their exact format. The 'core' scope is not accessible.",
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['get', 'set', 'unset'] },
            uuid: {
              type: 'string',
              description: 'Document UUID, e.g. "Actor.KEinmzpxY3CnAD2W" or "Actor.x.Item.y".',
            },
            actor: {
              type: 'string',
              description: 'Alternative to uuid for actors: actor name or id.',
            },
            scope: {
              type: 'string',
              description:
                'Flag scope: a module id (e.g. "cinematic-cut-ins"), the system id, or "world".',
            },
            key: {
              type: 'string',
              description: 'Flag key within the scope; dot paths allowed (e.g. "triggers.chat").',
            },
            value: { description: 'For "set": the JSON value to write.' },
            replace: {
              type: 'boolean',
              description: 'For "set": overwrite the key instead of merging objects into it.',
            },
          },
          required: ['action', 'scope'],
        },
      },
      {
        name: 'manage-module-settings',
        description:
          "Read or write a module's registered Foundry settings (game.settings). Many modules " +
          'keep world-wide data here, e.g. global or scene presets.\n' +
          '- "list": every setting registered by the module, with its scope (world/client), ' +
          'name and current value. Read-only.\n' +
          '- "get": one setting\'s current value. Read-only.\n' +
          '- "set": replace one setting\'s value entirely (no merge). GM-only, needs Allow Write ' +
          'Operations. Always "get" first and send back the full value with only your changes.\n' +
          "The 'core' scope is not accessible.",
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'get', 'set'] },
            scope: { type: 'string', description: 'Module id, e.g. "cinematic-cut-ins".' },
            key: { type: 'string', description: 'Setting key, e.g. "globalPresets".' },
            value: { description: 'For "set": the complete new value.' },
          },
          required: ['action', 'scope'],
        },
      },
    ];
  }

  async handleManageFlags(args: unknown) {
    const parsed = manageFlagsSchema.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);

    this.logger.info('Managing flags', {
      action: parsed.data.action,
      target: parsed.data.uuid ?? parsed.data.actor,
      scope: parsed.data.scope,
      key: parsed.data.key,
    });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.manageFlags', parsed.data);
    } catch (error) {
      this.logger.error('Failed to manage flags', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async handleManageModuleSettings(args: unknown) {
    const parsed = manageSettingsSchema.safeParse(args);
    if (!parsed.success) return invalidArgs(parsed.error);

    this.logger.info('Managing module settings', {
      action: parsed.data.action,
      scope: parsed.data.scope,
      key: parsed.data.key,
    });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.manageModuleSettings', parsed.data);
    } catch (error) {
      this.logger.error('Failed to manage module settings', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}

function invalidArgs(error: z.ZodError) {
  const detail = error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return { success: false, error: `Invalid arguments: ${detail}` };
}
