// Downloaded from https://deno.land/x/httpcache@0.1.2/in_memory.ts

import { LruCache } from "@std/cache/lru-cache";
import { Cache, CachedResponse } from "./mod.ts";
export { Cache };

export function inMemoryCache(capacity: number): Cache {
  const lru = new LruCache<string,CachedResponse>(capacity);
  return new Cache({
    get(url) {
      return Promise.resolve(lru.get(url));
    },
    set(url, resp) {
      lru.set(url, resp);
      return Promise.resolve();
    },
    delete(url) {
      lru.delete(url);
      return Promise.resolve();
    },
    close() {
      lru.clear();
    },
  });
}
