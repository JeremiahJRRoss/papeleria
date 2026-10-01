/** Every object `deepFreeze` has frozen with everything reachable from it. */
const deeplyFrozen = new WeakSet<object>();

/**
 * Freezes a value and everything reachable from it, a Map's keys and values
 * included. An object is passed over only when this function has frozen it
 * all the way down already, so shared parts and cycles are visited once while
 * an object someone froze only at the top is still followed. A Map's own set,
 * delete and clear are not stopped by freezing, which is why the manifest's
 * source map is a read-only wrapper rather than a Map (D164).
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !deeplyFrozen.has(value)) {
    deeplyFrozen.add(value);
    Object.freeze(value);
    if (value instanceof Map) {
      for (const [key, child] of value) {
        deepFreeze(key);
        deepFreeze(child);
      }
    }
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
