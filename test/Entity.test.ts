import {describe, expect, expectTypeOf, it} from 'vitest'
import {z} from 'zod'
import {Entity} from '../src'

const accountPropsSchema = z.object({
  name: z.string().min(1),
  bsb: z.string().regex(/^\d{6}$/),
  accountNumber: z.string().regex(/^\d{4,10}$/),
  balance: z.number().min(0),
  tenantId: z.string().min(1),
})

const onDeposited = Entity.defineEvent(accountPropsSchema, 'deposited', {
  schema: () => z.object({amount: z.number().positive()}),
  mutate: ({event, props}) => {
    props.balance += event.amount
    return {newBalance: props.balance}
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
  mutate: ({event, props, next}) => {
    props.name = event.name
    props.bsb = event.bsb
    props.accountNumber = event.accountNumber
    props.tenantId = event.tenantId
    props.balance = 0
    if (event.openingBalance && event.openingBalance > 0) {
      next(onDeposited, {amount: event.openingBalance})
    }
  },
})

const onWithdrawn = Entity.defineEvent(accountPropsSchema, 'withdrawn', {
  schema: () => z.object({amount: z.number().positive()}),
  mutate: ({event, props}) => {
    const previousBalance = props.balance
    props.balance -= event.amount
    return {previousBalance, newBalance: props.balance}
  },
})

const onRenamed = Entity.defineEvent(accountPropsSchema, 'renamed', {
  schema: () => z.object({name: z.string().min(1)}),
  mutate: ({event, props}) => {
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

const validCreatedPayload = {
  name: 'Operating',
  bsb: '062000',
  accountNumber: '12345678',
  tenantId: 'tenant-1',
}

describe('Entity.define', () => {
  it('applies a basic mutation and records a journal event', () => {
    const account = new Account()
    account.mutate('account.created', validCreatedPayload)

    expect(account.props.name).toBe('Operating')
    expect(account.props.bsb).toBe('062000')
    expect(account.props.balance).toBe(0)
    expect(account.version).toBe(1)
    expect(account.events).toHaveLength(1)
    expect(account.events[0]?.type).toBe('account.created')
    expect(account.events[0]?.version).toBe(1)
    expect(account.hasMutated).toBe(true)
  })

  it('exposes an ergonomic getter named after idField', () => {
    const account = new Account({id: 'fixed-id'})
    expect(account.id).toBe('fixed-id')
    expect(account.accountId).toBe('fixed-id')
  })

  it('generates a UUID when no id is supplied', () => {
    const a = new Account()
    const b = new Account()
    expect(a.id).not.toBe(b.id)
    expect(a.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  it('aborts and leaves state unchanged when post-handler validation fails', () => {
    const account = new Account()
    account.mutate('account.created', validCreatedPayload)
    account.mutate('account.deposited', {amount: 100})

    const versionBefore = account.version
    const eventsBefore = account.events.length
    const propsBefore = account.props

    expect(() =>
      account.mutate('account.withdrawn', {amount: 250}),
    ).toThrow(Entity.EntityValidationError)

    expect(account.version).toBe(versionBefore)
    expect(account.events.length).toBe(eventsBefore)
    expect(account.props).toBe(propsBefore)
    expect(account.props.balance).toBe(100)
  })

  it('throws when payload validation fails and leaves state unchanged', () => {
    const account = new Account()
    expect(() =>
      account.mutate('account.created', {
        ...validCreatedPayload,
        bsb: 'not-a-bsb',
      }),
    ).toThrow()
    expect(account.version).toBe(0)
    expect(account.events).toHaveLength(0)
  })

  it('throws EntityUnknownEventError on an unregistered event type', () => {
    const account = new Account()
    expect(() =>
      // @ts-expect-error — intentionally invalid event type
      account.mutate('account.never_defined', {}),
    ).toThrow(Entity.EntityUnknownEventError)
  })

  it('chains events via next(handler, payload)', () => {
    const account = new Account()
    account.mutate('account.created', {
      ...validCreatedPayload,
      openingBalance: 500,
    })
    expect(account.version).toBe(2)
    expect(account.events).toHaveLength(2)
    expect(account.events[0]?.type).toBe('account.created')
    expect(account.events[1]?.type).toBe('account.deposited')
    expect(account.props.balance).toBe(500)
  })

  it('returns the value produced by the originally-called handler', () => {
    const account = new Account()
    account.mutate('account.created', validCreatedPayload)

    const first = account.mutate('account.deposited', {amount: 200})
    expect(first).toEqual({newBalance: 200})

    const second = account.mutate('account.withdrawn', {amount: 75})
    expect(second).toEqual({previousBalance: 200, newBalance: 125})
  })

  it('treats version > 0 as loaded-from-storage', () => {
    const account = new Account({
      id: 'storage-id',
      version: 5,
      props: {
        name: 'Loaded',
        bsb: '062001',
        accountNumber: '99999999',
        balance: 1000,
        tenantId: 'tenant-1',
      },
    })
    expect(account.version).toBe(5)
    expect(account.events).toHaveLength(0)
    expect(account.hasMutated).toBe(false)

    account.mutate('account.deposited', {amount: 50})
    expect(account.version).toBe(6)
    expect(account.events[0]?.version).toBe(6)
    expect(account.props.balance).toBe(1050)
  })

  it('reset() clears the journal but keeps props and version', () => {
    const account = new Account()
    account.mutate('account.created', validCreatedPayload)
    account.mutate('account.deposited', {amount: 300})
    expect(account.events).toHaveLength(2)

    account.reset()
    expect(account.events).toHaveLength(0)
    expect(account.hasMutated).toBe(false)
    expect(account.version).toBe(2)
    expect(account.props.balance).toBe(300)
  })

  it('honours a subclass cloneProps override', () => {
    let cloneCalls = 0

    class CountingAccount extends Entity.define(
      {
        name: 'account',
        idField: 'accountId',
        schema: () => accountPropsSchema,
      },
      [onCreated, onDeposited, onWithdrawn, onRenamed],
    ) {
      cloneProps() {
        cloneCalls++
        return {...this.props}
      }
    }

    const account = new CountingAccount()
    account.mutate('account.created', {
      ...validCreatedPayload,
      openingBalance: 100,
    })
    expect(cloneCalls).toBe(2)
  })

  it('exposes the entity name and idField as statics', () => {
    expect(Account.aggregateName).toBe('account')
    expect(Account.idField).toBe('accountId')
  })

  it('toStorage() snapshots id, version, props, events, hasMutated', () => {
    const account = new Account()
    account.mutate('account.created', validCreatedPayload)
    account.mutate('account.deposited', {amount: 250})

    const snapshot = account.toStorage()
    expect(snapshot.id).toBe(account.id)
    expect(snapshot.version).toBe(2)
    expect(snapshot.props).toEqual(account.props)
    expect(snapshot.hasMutated).toBe(true)
    expect(snapshot.events).toHaveLength(2)
    expect(snapshot.events[0]?.type).toBe('account.created')
    expect(snapshot.events[1]?.type).toBe('account.deposited')
  })

  it('fromStorage() parses props through the schema and rehydrates', () => {
    const loaded = Account.fromStorage({
      id: 'storage-id',
      version: 7,
      props: {
        name: 'Restored',
        bsb: '062002',
        accountNumber: '11112222',
        balance: 4200,
        tenantId: 'tenant-1',
      },
    })

    expect(loaded).toBeInstanceOf(Account)
    expect(loaded.id).toBe('storage-id')
    expect(loaded.accountId).toBe('storage-id')
    expect(loaded.version).toBe(7)
    expect(loaded.props.balance).toBe(4200)
    expect(loaded.events).toHaveLength(0)

    loaded.mutate('account.deposited', {amount: 100})
    expect(loaded.version).toBe(8)
    expect(loaded.events[0]?.version).toBe(8)
  })

  it('fromStorage() rejects malformed props at the storage boundary', () => {
    expect(() =>
      Account.fromStorage({
        id: 'bad-id',
        version: 1,
        props: {
          name: 'Bad',
          bsb: '12',
          accountNumber: '12345678',
          balance: 0,
          tenantId: 'tenant-1',
        },
      }),
    ).toThrow()
  })

  it('toStorage() output round-trips through fromStorage()', () => {
    const original = new Account()
    original.mutate('account.created', {
      ...validCreatedPayload,
      openingBalance: 750,
    })
    const snapshot = original.toStorage()

    const restored = Account.fromStorage({
      id: snapshot.id,
      version: snapshot.version,
      props: snapshot.props,
    })
    expect(restored.id).toBe(original.id)
    expect(restored.version).toBe(original.version)
    expect(restored.props).toEqual(original.props)
  })

  it('Account instances are also Entity.GenericEntity instances', () => {
    const account = new Account()
    expect(account).toBeInstanceOf(Entity.GenericEntity)
    expect(account).toBeInstanceOf(Account)
  })

  it('Entity.GenericEntity accepts any defined entity in function signatures', () => {
    function snapshotInfo(entity: Entity.GenericEntity) {
      const snap = entity.toStorage()
      return {
        id: snap.id,
        version: snap.version,
        committed: snap.events.length,
      }
    }

    const account = new Account()
    account.mutate('account.created', validCreatedPayload)
    account.mutate('account.deposited', {amount: 100})

    const info = snapshotInfo(account)
    expect(info.id).toBe(account.id)
    expect(info.version).toBe(2)
    expect(info.committed).toBe(2)
  })

  it('Entity.GenericJournalEvent accepts any committed journal event', () => {
    function summarize(event: Entity.GenericJournalEvent) {
      return `${event.type}@v${event.version}`
    }

    const account = new Account()
    account.mutate('account.created', {
      ...validCreatedPayload,
      openingBalance: 250,
    })

    const summaries = account.events.map(summarize)
    expect(summaries).toEqual([
      'account.created@v1',
      'account.deposited@v2',
    ])
  })

  it('Entity.GenericEntity is abstract — direct instantiation throws on use', () => {
    const generic = new Entity.GenericEntity()
    expect(() => generic.id).toThrow(/abstract/)
    expect(() => generic.version).toThrow(/abstract/)
    expect(() => generic.props).toThrow(/abstract/)
    expect(() => generic.events).toThrow(/abstract/)
    expect(() => generic.hasMutated).toThrow(/abstract/)
    expect(() => generic.reset()).toThrow(/abstract/)
    expect(() => generic.toStorage()).toThrow(/abstract/)
    expect(() => generic.cloneProps()).toThrow(/abstract/)
  })

  it('exposes the entity schema as a static accessor', () => {
    const schema = Account.schema()
    expect(schema).toBe(accountPropsSchema)
    // Schema should round-trip valid props
    expect(
      schema.parse({
        name: 'Schema',
        bsb: '062000',
        accountNumber: '12345678',
        balance: 0,
        tenantId: 'tenant-1',
      }).name,
    ).toBe('Schema')
  })

  it('throws EntityUnknownEventError when next() is called with a handler from another entity', () => {
    const otherSchema = z.object({foo: z.string()})
    const foreignHandler = Entity.defineEvent(otherSchema, 'foreign', {
      schema: () => z.object({}),
      mutate: () => {},
    })

    const onCreatedWithForeignNext = Entity.defineEvent(
      accountPropsSchema,
      'created_with_foreign',
      {
        schema: () => z.object({}),
        mutate: ({props, next}) => {
          props.name = 'temp'
          props.bsb = '062000'
          props.accountNumber = '12345678'
          props.tenantId = 'tenant-1'
          props.balance = 0
          // Cast through `unknown` because TS would otherwise correctly reject
          // a handler typed against a different props schema. We want to test
          // the runtime guard.
          next(
            foreignHandler as unknown as typeof onCreatedWithForeignNext,
            {} as never,
          )
        },
      },
    )

    class TempAccount extends Entity.define(
      {
        name: 'account',
        idField: 'accountId',
        schema: () => accountPropsSchema,
      },
      [onCreatedWithForeignNext],
    ) {}

    const account = new TempAccount()
    expect(() =>
      account.mutate('account.created_with_foreign', {}),
    ).toThrow(Entity.EntityUnknownEventError)
  })

  it('rejects duplicate handler registrations', () => {
    const dup1 = Entity.defineEvent(accountPropsSchema, 'noop', {
      schema: () => z.object({}),
      mutate: () => {},
    })
    const dup2 = Entity.defineEvent(accountPropsSchema, 'noop', {
      schema: () => z.object({}),
      mutate: () => {},
    })
    expect(() =>
      Entity.define(
        {
          name: 'account',
          idField: 'accountId',
          schema: () => accountPropsSchema,
        },
        [dup1, dup2],
      ),
    ).toThrow(/Duplicate event handler/)
  })
})

describe('Entity.eventsOf', () => {
  it('extracts the union of all qualified event types', () => {
    type AllEventTypes = Entity.eventsOf<Account>['type']
    expectTypeOf<AllEventTypes>().toEqualTypeOf<
      | 'account.created'
      | 'account.deposited'
      | 'account.withdrawn'
      | 'account.renamed'
    >()
  })

  it('narrows to a single event when given a qualified type name', () => {
    type Created = Entity.eventsOf<Account, 'account.created'>
    expectTypeOf<Created['type']>().toEqualTypeOf<'account.created'>()
    expectTypeOf<Created['payload']['name']>().toEqualTypeOf<string>()
    expectTypeOf<Created['payload']['bsb']>().toEqualTypeOf<string>()
    expectTypeOf<Created['payload']['tenantId']>().toEqualTypeOf<string>()
    expectTypeOf<Created['payload']['openingBalance']>().toEqualTypeOf<
      number | undefined
    >()
  })
})

describe('Entity.storageValue', () => {
  it('matches the toStorage() return shape', () => {
    type AccountStorage = Entity.storageValue<Account>
    expectTypeOf<AccountStorage['id']>().toEqualTypeOf<string>()
    expectTypeOf<AccountStorage['version']>().toEqualTypeOf<number>()
    expectTypeOf<AccountStorage['hasMutated']>().toEqualTypeOf<boolean>()
    expectTypeOf<AccountStorage['props']['balance']>().toEqualTypeOf<number>()
    expectTypeOf<AccountStorage['props']['bsb']>().toEqualTypeOf<string>()
    expectTypeOf<AccountStorage['props']['tenantId']>().toEqualTypeOf<string>()
  })
})
