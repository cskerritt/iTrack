// A DOM-free model of which dialogs are open, in mount order, and what must
// be inert while the top-most is up: every page root a caller hands in and
// every lower dialog's backdrop. Pure so node:test drives it with plain
// objects (tests/primitives.test.mjs); app/components/Modal.tsx feeds it real
// elements. Nothing here reads the DOM or the clock.
export type InertHost = { inert: boolean };

export type ModalStack<T extends InertHost> = {
  open(id: string, host: T): void;
  close(id: string): void;
  isTop(id: string): boolean;
  size(): number;
  // Re-derives every inert flag from the current order: the roots are inert
  // while anything is open (the value each had before the first dialog is
  // restored when the last closes), and every backdrop but the top-most is
  // inert.
  sync(roots: Iterable<T>): void;
};

export function createModalStack<T extends InertHost>(): ModalStack<T> {
  const order: string[] = [];
  const hosts = new Map<string, T>();
  const priorRootState = new Map<T, boolean>();
  const top = () =>
    order.length > 0 ? hosts.get(order[order.length - 1]) : undefined;
  return {
    open(id, host) {
      order.push(id);
      hosts.set(id, host);
    },
    close(id) {
      const index = order.lastIndexOf(id);
      if (index !== -1) order.splice(index, 1);
      hosts.delete(id);
    },
    isTop: (id) => order.length > 0 && order[order.length - 1] === id,
    size: () => order.length,
    sync(roots) {
      const current = top();
      for (const root of roots) {
        if (current === undefined) {
          if (priorRootState.has(root)) {
            root.inert = priorRootState.get(root) as boolean;
            priorRootState.delete(root);
          }
          continue;
        }
        if (!priorRootState.has(root)) priorRootState.set(root, root.inert);
        root.inert = true;
      }
      for (const host of hosts.values()) {
        host.inert = current !== undefined && host !== current;
      }
    },
  };
}
