import type { LocalToolServices } from "./localTools.js";

export function createExternalLocalToolServices(): Pick<
  LocalToolServices,
  "fetch" | "now" | "setTimeout" | "clearTimeout"
> {
  return {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timeout) => clearTimeout(timeout)
  };
}
