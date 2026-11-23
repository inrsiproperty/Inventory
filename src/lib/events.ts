// Tiny event bus so the sync engine hears about local changes without circular imports.
export const bus = new EventTarget();

export function localChange() {
  bus.dispatchEvent(new Event('local-change'));
}
