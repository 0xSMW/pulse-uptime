import { beforeAll } from "vitest"

// Node 22+ can leave window.localStorage undefined under jsdom without
// an origin-backed storage polyfill. Component tests share this setup.
beforeAll(() => {
  if (typeof window === "undefined") {
    return
  }
  if (typeof window.localStorage?.getItem === "function") {
    return
  }
  const store = new Map<string, string>()
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, String(value))
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
      clear: () => {
        store.clear()
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size
      },
    },
  })
})
