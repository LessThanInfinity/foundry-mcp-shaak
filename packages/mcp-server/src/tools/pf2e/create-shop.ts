import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface PF2eCreateShopToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

// A random draw indexes every Item compendium, which on a remote host (e.g. Molten)
// can take well over the default 10s query timeout.
const CREATE_SHOP_TIMEOUT_MS = 90000;

const RARITIES = ['common', 'uncommon', 'rare', 'unique'] as const;
const PHYSICAL_TYPES = [
  'weapon',
  'armor',
  'shield',
  'equipment',
  'consumable',
  'treasure',
  'backpack',
] as const;

const itemSchema = z
  .object({
    name: z.string().min(1),
    quantity: z.number().int().min(1).optional(),
    pack: z.string().optional(),
  })
  .strict();

const randomSchema = z
  .object({
    count: z.number().int().min(1).max(100),
    minLevel: z.number().int().min(0).max(30).optional(),
    maxLevel: z.number().int().min(0).max(30).optional(),
    rarities: z.array(z.enum(RARITIES)).optional(),
    types: z.array(z.enum(PHYSICAL_TYPES)).optional(),
    traits: z.array(z.string().min(1)).optional(),
    maxQuantity: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const createShopSchema = z
  .object({
    name: z.string().min(1),
    folder: z.string().min(1).optional(),
    items: z.array(itemSchema).optional(),
    random: randomSchema.optional(),
  })
  .strict()
  .refine(d => (d.items && d.items.length > 0) || d.random, {
    message: 'Provide "items", "random", or both',
  });

/**
 * PF2e create-shop tool. Creates a Loot actor in Merchant mode and stocks it with
 * physical items copied from the installed PF2e compendiums, either named
 * explicitly, drawn at random by level/rarity/type/trait, or both.
 */
export class PF2eCreateShopTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: PF2eCreateShopToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'PF2eCreateShopTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'pf2e-create-shop',
        description:
          '[PF2e only] Create a shop: a Loot actor in Merchant mode stocked with items copied in ' +
          'full from the installed PF2e compendiums. Name items explicitly in "items" (matched ' +
          'case-insensitively against physical item types: weapon, armor, shield, equipment, ' +
          'consumable, treasure, backpack), and/or use "random" to draw a number of distinct items ' +
          'filtered by level range, rarity, item type and traits (e.g. a level 3-6 alchemist with ' +
          'traits ["alchemical"]). Names not found are reported back, not invented. USE THIS for ' +
          'merchants and stores; for a generic actor use manage-actors.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Shop name, used as the Loot actor name (e.g. "Grimbo\'s Potions").',
            },
            folder: {
              type: 'string',
              description: 'Optional Actor folder name to place the shop in (created if missing).',
            },
            items: {
              type: 'array',
              description: 'Specific items to stock.',
              items: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'Exact item name (e.g. "Healing Potion (Minor)", "Longsword").',
                  },
                  quantity: { type: 'number', description: 'Stock quantity (default 1).' },
                  pack: {
                    type: 'string',
                    description:
                      'Optional compendium pack id (or fragment) to source the item from.',
                  },
                },
                required: ['name'],
                additionalProperties: false,
              },
            },
            random: {
              type: 'object',
              description: 'Draw random distinct items matching these filters.',
              properties: {
                count: { type: 'number', description: 'How many distinct items to draw (1-100).' },
                minLevel: { type: 'number', description: 'Minimum item level (inclusive).' },
                maxLevel: { type: 'number', description: 'Maximum item level (inclusive).' },
                rarities: {
                  type: 'array',
                  items: { type: 'string', enum: [...RARITIES] },
                  description: 'Allowed rarities (default: common only).',
                },
                types: {
                  type: 'array',
                  items: { type: 'string', enum: [...PHYSICAL_TYPES] },
                  description: 'Allowed item types (default: all physical types).',
                },
                traits: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Item must have at least one of these traits (e.g. "alchemical", "magical", "potion").',
                },
                maxQuantity: {
                  type: 'number',
                  description: 'Each drawn item gets a random quantity from 1 to this (default 1).',
                },
              },
              required: ['count'],
              additionalProperties: false,
            },
          },
          required: ['name'],
        },
      },
    ];
  }

  async handleCreateShop(args: unknown) {
    const parsed = createShopSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    this.logger.info('Creating PF2e shop', {
      name: parsed.data.name,
      items: parsed.data.items?.length ?? 0,
      random: parsed.data.random?.count ?? 0,
    });
    try {
      return await this.foundryClient.query(
        'foundry-mcp-bridge.createPf2eShop',
        parsed.data,
        CREATE_SHOP_TIMEOUT_MS
      );
    } catch (error) {
      this.logger.error('Failed to create PF2e shop', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
