/** Memoise a zero-arg function so it only runs once. */
export function once<T extends (...args: any[]) => any>(fn: T): T {
  let called = false
  let result: ReturnType<T>

  return ((...args: Parameters<T>) => {
    if (!called) {
      result = fn(...args)
      called = true
    }
    return result
  }) as T
}

/**
 * Deep-clones a value. Dispatch order: primitives → `.clone()` method →
 * arrays → plain objects → `structuredClone` for everything else.
 *
 * @example
 * const cloned = deepClone({
 *   amount: 100,
 *   createdAt: new Date(),
 *   money: new Money(50), // delegates to money.clone() if defined
 * })
 */
export function deepClone<T>(value: T): T {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t !== 'object') return value

  const maybeClone = (value as { clone?: () => unknown }).clone
  if (typeof maybeClone === 'function') {
    return maybeClone.call(value) as T
  }

  if (Array.isArray(value)) {
    const result = new Array(value.length)
    for (let i = 0; i < value.length; i++) {
      result[i] = deepClone(value[i])
    }
    return result as unknown as T
  }

  const proto = Object.getPrototypeOf(value)
  if (proto === Object.prototype || proto === null) {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as object)) {
      result[key] = deepClone((value as Record<string, unknown>)[key])
    }
    return result as T
  }

  return structuredClone(value)
}
