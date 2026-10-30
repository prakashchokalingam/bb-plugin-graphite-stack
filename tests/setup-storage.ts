// Node 22 exposes an empty localStorage stub in jsdom. Views persist the rail
// scope through window.localStorage, so tests need a working Storage.
if (typeof window !== "undefined" && typeof window.localStorage?.getItem !== "function") {
  const items = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, String(value)),
      removeItem: (key: string) => void items.delete(key),
      clear: () => items.clear(),
      key: (index: number) => [...items.keys()][index] ?? null,
      get length() {
        return items.size;
      },
    },
  });
}
