import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Entity } from '../src'

const accountPropsSchema = z.object({
  name: z.string().min(1),
  bsb: z.string().regex(/^\d{6}$/),
  accountNumber: z.string().regex(/^\d{4,10}$/),
  balance: z.number().min(0),
  tenantId: z.string().min(1),
})

const onDeposited = Entity.defineEvent(accountPropsSchema, 'deposited', {
  schema: () => z.object({ amount: z.number().positive() }),
  mutate: ({ event, props }) => {
    props.balance += event.amount
    return { newBalance: props.balance }
  },
})

const onWithdrawn = Entity.defineEvent(accountPropsSchema, 'withdrawn', {
  schema: () => z.object({ amount: z.number().positive() }),
  mutate: ({ event, props }) => {
    if (event.amount > props.balance) throw new Error('Insufficient funds')
    props.balance -= event.amount
    return { newBalance: props.balance }
  },
})

const onCreated = Entity.defineEvent(accountPropsSchema, 'created', {
  schema: () =>
    z.object({
      name: z.string().min(1),
      bsb: z.string().regex(/^\d{6}$/),
      accountNumber: z.string().regex(/^\d{4,10}$/),
      tenantId: z.string().min(1),
      openingBalance: z.number().min(0).optional(),
    }),
  mutate: ({ event, props, next }) => {
    props.name = event.name
    props.bsb = event.bsb
    props.accountNumber = event.accountNumber
    props.tenantId = event.tenantId
    props.balance = 0
    if (event.openingBalance && event.openingBalance > 0) {
      next(onDeposited, { amount: event.openingBalance })
    }
  },
})

const onRenamed = Entity.defineEvent(accountPropsSchema, 'renamed', {
  schema: () => z.object({ name: z.string().min(1) }),
  mutate: ({ event, props }) => {
    props.name = event.name
  },
})

class Account extends Entity.define(
  {
    name: 'account',
    idField: 'accountId',
    schema: () => accountPropsSchema,
  },
  [onCreated, onDeposited, onWithdrawn, onRenamed],
) {
  get displayName() {
    return `${this.props.name} (${this.props.bsb}-${this.props.accountNumber})`
  }
}

describe('Account end-to-end scenario', () => {
  it('runs the full lifecycle of an account', () => {
    const account = new Account()

    account.mutate('account.created', {
      name: 'Operating',
      bsb: '062000',
      accountNumber: '12345678',
      tenantId: 'tenant-1',
      openingBalance: 1000,
    })

    expect(account.version).toBe(2)
    expect(account.events.map((e) => e.type)).toEqual([
      'account.created',
      'account.deposited',
    ])
    expect(account.props.balance).toBe(1000)
    expect(account.displayName).toBe('Operating (062000-12345678)')

    const deposit = account.mutate('account.deposited', { amount: 250 })
    expect(deposit).toEqual({ newBalance: 1250 })

    const withdrawal = account.mutate('account.withdrawn', { amount: 100 })
    expect(withdrawal).toEqual({ newBalance: 1150 })
    expect(account.props.balance).toBe(1150)

    account.mutate('account.renamed', { name: 'Operating Account' })
    expect(account.props.name).toBe('Operating Account')

    expect(account.version).toBe(5)
    expect(account.events).toHaveLength(5)
    expect(account.events.map((e) => e.version)).toEqual([1, 2, 3, 4, 5])
  })

  it('rehydrates an account from storage and continues mutating', () => {
    const stored = Account.fromStorage({
      id: 'account-from-db',
      version: 12,
      props: {
        name: 'Savings',
        bsb: '062001',
        accountNumber: '99999999',
        balance: 5000,
        tenantId: 'tenant-1',
      },
    })

    expect(stored.accountId).toBe('account-from-db')
    expect(stored.events).toHaveLength(0)
    expect(stored.hasMutated).toBe(false)

    stored.mutate('account.deposited', { amount: 750 })
    expect(stored.version).toBe(13)
    expect(stored.events[0]?.version).toBe(13)
    expect(stored.props.balance).toBe(5750)
  })

  it('refuses to overdraw and leaves state unchanged', () => {
    const account = new Account()
    account.mutate('account.created', {
      name: 'Operating',
      bsb: '062000',
      accountNumber: '12345678',
      tenantId: 'tenant-1',
      openingBalance: 100,
    })

    const versionBefore = account.version
    expect(() =>
      account.mutate('account.withdrawn', { amount: 500 }),
    ).toThrow(/Insufficient funds/)
    expect(account.version).toBe(versionBefore)
    expect(account.props.balance).toBe(100)
  })

  it('snapshots and round-trips through toStorage/fromStorage', () => {
    const original = new Account()
    original.mutate('account.created', {
      name: 'Operating',
      bsb: '062000',
      accountNumber: '12345678',
      tenantId: 'tenant-1',
      openingBalance: 500,
    })

    const snapshot = original.toStorage()
    expect(snapshot.version).toBe(2)
    expect(snapshot.events).toHaveLength(2)

    const restored = Account.fromStorage({
      id: snapshot.id,
      version: snapshot.version,
      props: snapshot.props,
    })
    expect(restored.id).toBe(original.id)
    expect(restored.version).toBe(original.version)
    expect(restored.props).toEqual(original.props)
  })
})
