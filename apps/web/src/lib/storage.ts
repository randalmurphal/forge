import { Debouncer } from "@tanstack/react-pacer";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface DebouncedStorage<R = unknown> extends StateStorage<R> {
  flush: () => void;
}

export function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

export function isStateStorage(
  storage: Partial<StateStorage> | null | undefined,
): storage is StateStorage {
  return (
    storage !== null &&
    storage !== undefined &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  );
}

export function resolveStorage(storage: Partial<StateStorage> | null | undefined): StateStorage {
  return isStateStorage(storage) ? storage : createMemoryStorage();
}

export function createKeyMigratingStorage(
  baseStorage: Partial<StateStorage> | null | undefined,
  migrations: Readonly<Record<string, readonly string[]>>,
): StateStorage {
  const storage = resolveStorage(baseStorage);

  const clearLegacyKeys = (name: string) => {
    for (const legacyKey of migrations[name] ?? []) {
      storage.removeItem(legacyKey);
    }
  };

  const migrateFromLegacy = (
    name: string,
    index: number = 0,
  ): string | null | Promise<string | null> => {
    const legacyKey = migrations[name]?.[index];
    if (!legacyKey) {
      return null;
    }

    const legacyValue = storage.getItem(legacyKey);
    if (legacyValue instanceof Promise) {
      return legacyValue.then((resolvedLegacyValue) => {
        if (resolvedLegacyValue === null) {
          return migrateFromLegacy(name, index + 1);
        }
        storage.setItem(name, resolvedLegacyValue);
        clearLegacyKeys(name);
        return resolvedLegacyValue;
      });
    }

    if (legacyValue === null) {
      return migrateFromLegacy(name, index + 1);
    }

    storage.setItem(name, legacyValue);
    clearLegacyKeys(name);
    return legacyValue;
  };

  return {
    getItem: (name) => {
      const currentValue = storage.getItem(name);
      if (currentValue instanceof Promise) {
        return currentValue.then((resolvedCurrentValue) => {
          if (resolvedCurrentValue !== null) {
            return resolvedCurrentValue;
          }
          return migrateFromLegacy(name);
        });
      }
      if (currentValue !== null) {
        return currentValue;
      }
      return migrateFromLegacy(name);
    },
    setItem: (name, value) => {
      storage.setItem(name, value);
      clearLegacyKeys(name);
    },
    removeItem: (name) => {
      storage.removeItem(name);
      clearLegacyKeys(name);
    },
  };
}

export function createDebouncedStorage(
  baseStorage: Partial<StateStorage> | null | undefined,
  debounceMs: number = 300,
): DebouncedStorage {
  const resolvedStorage = resolveStorage(baseStorage);
  const debouncedSetItem = new Debouncer(
    (name: string, value: string) => {
      resolvedStorage.setItem(name, value);
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => resolvedStorage.getItem(name),
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      resolvedStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}
