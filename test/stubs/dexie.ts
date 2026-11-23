// TEST-ONLY stand-in for the parts of Dexie the app uses, built on real IndexedDB.
// The real app is built with the genuine "dexie" package from npm; this exists only
// because packages can't be downloaded in the environment the tests ran in.

type Obs<T> = { next?: (v: T) => void; error?: (e: unknown) => void };
const listeners = new Set<() => void>();
let pending = false;
function notify() {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    listeners.forEach((l) => l());
  }, 0);
}

export function liveQuery<T>(fn: () => Promise<T> | T) {
  return {
    subscribe(o: Obs<T>) {
      let alive = true;
      let seq = 0;
      const run = async () => {
        const mine = ++seq;
        try {
          const v = await fn();
          if (alive && mine === seq) o.next?.(v);
        } catch (e) {
          if (alive) o.error?.(e);
        }
      };
      void run();
      listeners.add(run);
      return {
        unsubscribe() {
          alive = false;
          listeners.delete(run);
        },
      };
    },
  };
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

class Collection<T> {
  constructor(
    private t: Table<T, string>,
    private pred: (x: T) => boolean,
  ) {}
  async toArray() {
    return (await this.t.toArray()).filter(this.pred);
  }
  async count() {
    return (await this.toArray()).length;
  }
  async first() {
    return (await this.toArray())[0];
  }
}

class Where<T> {
  constructor(
    private t: Table<T, string>,
    private idx: string,
  ) {}
  equals(v: unknown) {
    return new Collection(this.t, (x) => (x as Record<string, unknown>)[this.idx] === v);
  }
  anyOf(vs: unknown[]) {
    return new Collection(this.t, (x) => vs.includes((x as Record<string, unknown>)[this.idx]));
  }
  notEqual(v: unknown) {
    return new Collection(this.t, (x) => (x as Record<string, unknown>)[this.idx] !== v);
  }
}

export class Table<T, K = string> {
  constructor(
    private db: Dexie,
    public name: string,
    private keyPath: string,
  ) {}
  private async store(mode: IDBTransactionMode) {
    const idb = await this.db.open();
    return idb.transaction(this.name, mode).objectStore(this.name);
  }
  async get(key: K): Promise<T | undefined> {
    if (key === undefined || key === null) return undefined;
    return req((await this.store('readonly')).get(key as IDBValidKey));
  }
  async bulkGet(keys: K[]): Promise<(T | undefined)[]> {
    return Promise.all(keys.map((k) => this.get(k)));
  }
  async put(obj: T): Promise<K> {
    const k = await req((await this.store('readwrite')).put(obj));
    notify();
    return k as K;
  }
  async bulkPut(arr: T[]) {
    const s = await this.store('readwrite');
    await Promise.all(arr.map((o) => req(s.put(o))));
    notify();
  }
  async update(key: K, changes: Partial<T> | Record<string, unknown>): Promise<number> {
    const s = await this.store('readwrite');
    const cur = await req(s.get(key as IDBValidKey));
    if (!cur) return 0;
    const next = { ...cur } as Record<string, unknown>;
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    await req(s.put(next));
    notify();
    return 1;
  }
  async delete(key: K) {
    await req((await this.store('readwrite')).delete(key as IDBValidKey));
    notify();
  }
  async toArray(): Promise<T[]> {
    return req((await this.store('readonly')).getAll()) as Promise<T[]>;
  }
  async count() {
    return req((await this.store('readonly')).count());
  }
  where(idx: string) {
    return new Where<T>(this as unknown as Table<T, string>, idx);
  }
  get keyPathName() {
    return this.keyPath;
  }
}

export default class Dexie {
  private _db?: Promise<IDBDatabase>;
  private _schema: Record<string, string> = {};
  private _version = 1;
  constructor(public name: string) {}
  version(n: number) {
    this._version = n;
    return {
      stores: (schema: Record<string, string>) => {
        this._schema = schema;
        for (const [t, spec] of Object.entries(schema)) {
          const keyPath = spec.split(',')[0].trim();
          (this as unknown as Record<string, unknown>)[t] = new Table(this, t, keyPath);
        }
        return this;
      },
    };
  }
  open(): Promise<IDBDatabase> {
    if (!this._db)
      this._db = new Promise((res, rej) => {
        const r = indexedDB.open(this.name, this._version * 10);
        r.onupgradeneeded = () => {
          for (const [t, spec] of Object.entries(this._schema)) {
            if (!r.result.objectStoreNames.contains(t)) r.result.createObjectStore(t, { keyPath: spec.split(',')[0].trim() });
          }
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    return this._db;
  }
  async transaction(_mode: string, _tables: unknown, fn: () => Promise<unknown>) {
    return fn();
  }
}
