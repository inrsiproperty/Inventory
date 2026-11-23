import type { Furnishing, Item, ItemCategory, Room, RoomTemplate } from './types';
import { uuid } from './util';

// Standard UK room and item list (spec decision: "Standard UK list, editable in the app").
// An item ending in "*" is only added for furnished or part-furnished properties.
export const DEFAULT_TEMPLATES: RoomTemplate[] = [
  {
    key: 'hallway',
    name: 'Hallway',
    items: [
      'Front door',
      'Door locks and handles',
      'Doorbell / entry phone',
      'Walls',
      'Ceiling',
      'Flooring',
      'Skirting boards',
      'Lights',
      'Switches and sockets',
      'Radiator',
      'Coat hooks*',
    ],
  },
  {
    key: 'living',
    name: 'Living room',
    items: [
      'Door',
      'Walls',
      'Ceiling',
      'Flooring',
      'Skirting boards',
      'Windows',
      'Curtains / blinds',
      'Lights',
      'Switches and sockets',
      'Radiator',
      'Fireplace',
      'Sofa*',
      'Armchairs*',
      'Coffee table*',
      'TV unit*',
    ],
  },
  {
    key: 'kitchen',
    name: 'Kitchen',
    items: [
      'Door',
      'Oven',
      'Hob',
      'Extractor',
      'Fridge freezer',
      'Washing machine',
      'Dishwasher',
      'Worktops',
      'Cupboards',
      'Sink and taps',
      'Flooring',
      'Walls',
      'Ceiling',
      'Windows',
      'Blinds',
      'Lights',
      'Sockets',
      'Radiator',
      'Microwave*',
      'Kettle and toaster*',
      'Crockery and cutlery*',
    ],
  },
  {
    key: 'bathroom',
    name: 'Bathroom',
    items: [
      'Door',
      'Bath',
      'Shower',
      'Shower screen / curtain',
      'Toilet',
      'Basin and taps',
      'Mirror',
      'Cabinet',
      'Extractor fan',
      'Tiles',
      'Walls',
      'Ceiling',
      'Flooring',
      'Lights',
      'Towel rail',
      'Window',
    ],
  },
  {
    key: 'bedroom',
    name: 'Bedroom',
    items: [
      'Door',
      'Walls',
      'Ceiling',
      'Flooring',
      'Skirting boards',
      'Windows',
      'Curtains / blinds',
      'Lights',
      'Switches and sockets',
      'Radiator',
      'Built-in wardrobe',
      'Bed frame*',
      'Mattress*',
      'Wardrobe*',
      'Chest of drawers*',
      'Bedside tables*',
    ],
  },
  {
    key: 'utility',
    name: 'Utility',
    items: ['Door', 'Boiler', 'Washing machine', 'Tumble dryer', 'Sink and taps', 'Cupboards', 'Walls', 'Ceiling', 'Flooring', 'Lights'],
  },
  {
    key: 'garden',
    name: 'Garden / exterior',
    items: ['Front of property', 'Garden gate', 'Fencing', 'Lawn', 'Patio / paths', 'Shed', 'Bins', 'Outside lights', 'Windows (outside)', 'Garden furniture*'],
  },
  {
    key: 'meters',
    name: 'Meter readings',
    category: 'meter',
    special: true,
    items: ['Gas meter', 'Electricity meter', 'Water meter'],
  },
  {
    key: 'keys',
    name: 'Keys and fobs',
    category: 'key',
    special: true,
    items: ['Front door keys', 'Back door keys', 'Window keys', 'Building fobs', 'Post box keys'],
  },
  {
    key: 'safety',
    name: 'Safety checks',
    category: 'safety',
    special: true,
    items: ['Smoke alarm (hallway)', 'Smoke alarm (landing)', 'Carbon monoxide alarm', 'Heat alarm (kitchen)'],
  },
  {
    key: 'documents',
    name: 'Manuals and documents',
    category: 'document',
    special: true,
    items: [
      'Gas Safety Certificate',
      'Energy Performance Certificate (EPC)',
      'Electrical Installation Condition Report (EICR)',
      'How to Rent guide',
      'Deposit protection information',
      'Appliance manuals',
    ],
  },
];

export interface RoomChoice {
  key: string; // template key
  name: string;
  include: boolean;
}

/** Default room list for a property, before the landlord edits it. */
export function defaultRoomChoices(templates: RoomTemplate[], bedrooms: number): RoomChoice[] {
  const out: RoomChoice[] = [];
  for (const t of templates) {
    if (t.special) continue;
    if (t.key === 'bedroom') {
      const n = Math.max(0, bedrooms);
      for (let i = 1; i <= n; i++) out.push({ key: 'bedroom', name: n === 1 ? 'Bedroom' : `Bedroom ${i}`, include: true });
      continue;
    }
    out.push({ key: t.key, name: t.name, include: true });
  }
  return out;
}

export function buildRoomsAndItems(
  inventoryId: string,
  templates: RoomTemplate[],
  choices: RoomChoice[],
  furnishing: Furnishing,
): { rooms: Room[]; items: Item[] } {
  const rooms: Room[] = [];
  const items: Item[] = [];
  const furnished = furnishing !== 'unfurnished';
  const chosen = choices.filter((c) => c.include);
  const specials = templates.filter((t) => t.special).map((t) => ({ key: t.key, name: t.name, include: true }));
  [...chosen, ...specials].forEach((c, ri) => {
    const t = templates.find((x) => x.key === c.key);
    const room: Room = { id: uuid(), inventoryId, name: c.name, order: ri, templateKey: c.key };
    rooms.push(room);
    const cat: ItemCategory = t?.category || 'general';
    (t?.items || [])
      .filter((n) => furnished || !n.trim().endsWith('*'))
      .forEach((raw, ii) => {
        const name = raw.trim().replace(/\*$/, '').trim();
        if (!name) return;
        items.push({
          id: uuid(),
          roomId: room.id,
          inventoryId,
          name,
          description: '',
          quantity: 1,
          order: ii,
          category: cat,
        });
      });
  });
  return { rooms, items };
}

export function categoryForTemplate(templates: RoomTemplate[], key: string): ItemCategory {
  return templates.find((t) => t.key === key)?.category || 'general';
}
