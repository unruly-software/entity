import { describe, expect, it } from 'vitest'
import { deepClone } from '../src/utils'

describe('deepClone', () => {
  it('returns primitives unchanged', () => {
    expect(deepClone(42)).toBe(42)
    expect(deepClone('hello')).toBe('hello')
    expect(deepClone(true)).toBe(true)
    expect(deepClone(null)).toBe(null)
    expect(deepClone(undefined)).toBe(undefined)
    expect(deepClone(BigInt(123))).toBe(BigInt(123))
  })

  it('deep-clones plain objects', () => {
    const original = { a: 1, b: { c: 2, d: [3, 4] } }
    const cloned = deepClone(original)
    expect(cloned).toEqual(original)
    expect(cloned).not.toBe(original)
    expect(cloned.b).not.toBe(original.b)
    expect(cloned.b.d).not.toBe(original.b.d)

    cloned.b.c = 999
    expect(original.b.c).toBe(2)
  })

  it('deep-clones arrays', () => {
    const original = [{ x: 1 }, { x: 2 }]
    const cloned = deepClone(original)
    expect(cloned).toEqual(original)
    expect(cloned).not.toBe(original)
    expect(cloned[0]).not.toBe(original[0])

    cloned[0]!.x = 999
    expect(original[0]!.x).toBe(1)
  })

  it('delegates to a `.clone()` method when present', () => {
    let cloneCalls = 0
    class Money {
      constructor(public readonly amount: number) {}
      clone(): Money {
        cloneCalls++
        return new Money(this.amount)
      }
    }

    const original = { price: new Money(100), other: 'thing' }
    const cloned = deepClone(original)

    expect(cloneCalls).toBe(1)
    expect(cloned.price).toBeInstanceOf(Money)
    expect(cloned.price).not.toBe(original.price)
    expect(cloned.price.amount).toBe(100)
    expect(cloned.other).toBe('thing')
  })

  it('delegates to `.clone()` even at the top level', () => {
    class Box {
      constructor(public readonly value: number) {}
      clone() {
        return new Box(this.value)
      }
    }
    const a = new Box(7)
    const b = deepClone(a)
    expect(b).toBeInstanceOf(Box)
    expect(b).not.toBe(a)
    expect(b.value).toBe(7)
  })

  it('preserves `this` when calling a prototype clone() method', () => {
    let observedThis: unknown
    class Account {
      constructor(public readonly balance: number) {}
      clone(): Account {
        observedThis = this
        return new Account(this.balance + 1)
      }
    }

    const original = new Account(100)
    const cloned = deepClone(original)
    expect(observedThis).toBe(original)
    expect(cloned).toBeInstanceOf(Account)
    expect(cloned.balance).toBe(101)
  })

  it('preserves `this` when clone() is nested inside a plain object', () => {
    let observedThis: unknown
    class Money {
      constructor(public readonly amount: number) {}
      clone() {
        observedThis = this
        return new Money(this.amount)
      }
    }

    const original = { wallet: { primary: new Money(50) } }
    const cloned = deepClone(original)
    expect(observedThis).toBe(original.wallet.primary)
    expect(cloned.wallet.primary).toBeInstanceOf(Money)
    expect(cloned.wallet.primary).not.toBe(original.wallet.primary)
    expect(cloned.wallet.primary.amount).toBe(50)
  })

  it('honours an immutable clone() that returns `this` unchanged', () => {
    class Email {
      constructor(public readonly value: string) {}
      clone(): Email {
        return this
      }
    }

    const e = new Email('alice@example.com')
    const original = { primary: e }
    const cloned = deepClone(original)
    expect(cloned).not.toBe(original)
    expect(cloned.primary).toBe(e)
  })

  it('honours an arrow-function clone bound via class fields', () => {
    class Counter {
      private readonly initial: number
      constructor(initial: number) {
        this.initial = initial
      }
      clone = (): Counter => new Counter(this.initial)
    }

    const original = new Counter(42)
    const cloned = deepClone(original)
    expect(cloned).toBeInstanceOf(Counter)
    expect(cloned).not.toBe(original)
    expect((cloned as any).initial).toBe(42)
  })

  it('delegates Date instances to structuredClone', () => {
    const original = { createdAt: new Date('2024-01-15T10:30:00Z') }
    const cloned = deepClone(original)
    expect(cloned.createdAt).toBeInstanceOf(Date)
    expect(cloned.createdAt).not.toBe(original.createdAt)
    expect(cloned.createdAt.getTime()).toBe(original.createdAt.getTime())
  })

  it('delegates Map and Set to structuredClone', () => {
    const original = {
      tags: new Set(['a', 'b', 'c']),
      lookup: new Map([['k', 'v']]),
    }
    const cloned = deepClone(original)
    expect(cloned.tags).toBeInstanceOf(Set)
    expect(cloned.tags).not.toBe(original.tags)
    expect(Array.from(cloned.tags)).toEqual(['a', 'b', 'c'])
    expect(cloned.lookup).toBeInstanceOf(Map)
    expect(cloned.lookup.get('k')).toBe('v')
  })

  it('handles nested mixes of clone(), Date, plain, and arrays', () => {
    class Token {
      constructor(public readonly value: string) {}
      clone() {
        return new Token(this.value)
      }
    }

    const original = {
      issuedAt: new Date('2024-06-01T00:00:00Z'),
      token: new Token('abc'),
      meta: {
        tags: ['x', 'y'],
        nested: { count: 3 },
      },
    }

    const cloned = deepClone(original)
    expect(cloned.issuedAt).not.toBe(original.issuedAt)
    expect(cloned.issuedAt.getTime()).toBe(original.issuedAt.getTime())
    expect(cloned.token).not.toBe(original.token)
    expect(cloned.token).toBeInstanceOf(Token)
    expect(cloned.meta).not.toBe(original.meta)
    expect(cloned.meta.nested).not.toBe(original.meta.nested)
    expect(cloned.meta.tags).toEqual(['x', 'y'])
  })

  it('handles a null-prototype object', () => {
    const original = Object.assign(Object.create(null), { a: 1, b: 2 })
    const cloned = deepClone(original)
    expect(cloned).toEqual({ a: 1, b: 2 })
    expect(cloned).not.toBe(original)
  })
})
