import {describe, expectTypeOf, it} from 'vitest'
import {z} from 'zod'
import {Entity} from '../src'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const accountPropsSchema = z.object({
  name: z.string().min(1),
  balance: z.number().min(0),
  tenantId: z.string().min(1),
})

type AccountProps = z.output<typeof accountPropsSchema>

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
      tenantId: z.string().min(1),
      openingBalance: z.number().min(0).optional(),
    }),
  mutate: ({event, props, next}) => {
    props.name = event.name
    props.tenantId = event.tenantId
    props.balance = 0
    if (event.openingBalance && event.openingBalance > 0) {
      next(onDeposited, {amount: event.openingBalance})
    }
  },
})

const onRenamed = Entity.defineEvent(accountPropsSchema, 'renamed', {
  schema: () => z.object({name: z.string().min(1)}),
  mutate: ({event, props}) => {
    props.name = event.name
  },
})

class Account extends Entity.define(
  {name: 'account', idField: 'accountId', schema: () => accountPropsSchema},
  [onCreated, onDeposited, onRenamed],
) {}

interface AuditCtx {
  tenantId: string
  actor: string
}

const Audited = Entity.withContext<AuditCtx>()

const onAuditedDeposited = Audited.defineEvent(
  accountPropsSchema,
  'deposited',
  {
    schema: () => z.object({amount: z.number().positive()}),
    mutate: ({event, props, context}) => {
      props.balance += event.amount
      return {newBalance: props.balance, by: context.actor}
    },
  },
)

const onAuditedRenamed = Audited.defineEvent(accountPropsSchema, 'renamed', {
  schema: () => z.object({name: z.string().min(1)}),
  mutate: ({event, props}) => {
    props.name = event.name
  },
})

// Context-free handler co-registered alongside context-bearing handlers — used
// to verify that mutate's rest tuple is per-handler, not per-entity.
const onAuditedTouched = Entity.defineEvent(accountPropsSchema, 'touched', {
  schema: () => z.object({}),
  mutate: ({props}) => {
    props.name = props.name
  },
})

class AuditedAccount extends Entity.define(
  {name: 'audited', idField: 'auditedId', schema: () => accountPropsSchema},
  [onAuditedDeposited, onAuditedRenamed, onAuditedTouched],
) {}

// ─────────────────────────────────────────────────────────────────────────────
// defineEvent — return shape
// ─────────────────────────────────────────────────────────────────────────────

describe('Entity.defineEvent type signature', () => {
  it('phantom-brands the props type onto the returned handler', () => {
    expectTypeOf(onDeposited.__propsBrand)
      .parameter(0)
      .toEqualTypeOf<AccountProps>()
  })

  it('phantom-brands the context as undefined when no context is bound', () => {
    expectTypeOf(onDeposited.__contextBrand)
      .parameter(0)
      .toEqualTypeOf<undefined>()
  })

  it('preserves the literal shortName as a string literal type', () => {
    expectTypeOf(onDeposited.shortName).toEqualTypeOf<'deposited'>()
    expectTypeOf(onCreated.shortName).toEqualTypeOf<'created'>()
    expectTypeOf(onRenamed.shortName).toEqualTypeOf<'renamed'>()
  })

  it('exposes a getSchema returning a zod type with the correct payload', () => {
    type DepositSchema = ReturnType<typeof onDeposited.getSchema>
    expectTypeOf<z.output<DepositSchema>>().toEqualTypeOf<{amount: number}>()
  })

  it('types handler input correctly with no context', () => {
    type Input = Parameters<typeof onDeposited.handler>[0]
    expectTypeOf<Input['event']>().toEqualTypeOf<{amount: number}>()
    expectTypeOf<Input['props']>().toEqualTypeOf<AccountProps>()
    expectTypeOf<Input['timestamp']>().toEqualTypeOf<Date>()
    expectTypeOf<Input['version']>().toEqualTypeOf<number>()
    expectTypeOf<Input['context']>().toEqualTypeOf<undefined>()
  })

  it('types the handler return value', () => {
    type Ret = ReturnType<typeof onDeposited.handler>
    expectTypeOf<Ret>().toEqualTypeOf<{newBalance: number}>()
    type CreatedRet = ReturnType<typeof onCreated.handler>
    expectTypeOf<CreatedRet>().toEqualTypeOf<void>()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// withContext — return shape
// ─────────────────────────────────────────────────────────────────────────────

describe('Entity.withContext type signature', () => {
  it('binds Context onto every handler produced by the builder', () => {
    expectTypeOf(onAuditedDeposited.__contextBrand)
      .parameter(0)
      .toEqualTypeOf<AuditCtx>()
  })

  it('types `context` inside the handler as the bound type', () => {
    type Input = Parameters<typeof onAuditedDeposited.handler>[0]
    expectTypeOf<Input['context']>().toEqualTypeOf<AuditCtx>()
  })

  it('returns a fresh builder object on each call (different bindings, different types)', () => {
    const A = Entity.withContext<{a: string}>()
    const B = Entity.withContext<{b: number}>()
    const aHandler = A.defineEvent(accountPropsSchema, 'a', {
      schema: () => z.object({}),
      mutate: ({context}) => context.a,
    })
    const bHandler = B.defineEvent(accountPropsSchema, 'b', {
      schema: () => z.object({}),
      mutate: ({context}) => context.b,
    })
    expectTypeOf(aHandler.__contextBrand)
      .parameter(0)
      .toEqualTypeOf<{a: string}>()
    expectTypeOf(bHandler.__contextBrand)
      .parameter(0)
      .toEqualTypeOf<{b: number}>()
  })

  it('preserves shortName literal through the builder', () => {
    expectTypeOf(onAuditedDeposited.shortName).toEqualTypeOf<'deposited'>()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// next() — chained handler typing
// ─────────────────────────────────────────────────────────────────────────────

describe('NextFn typing', () => {
  it('threads the props type through to chained handler payloads', () => {
    type Next = Parameters<typeof onCreated.handler>[0]['next']
    // Calling with the right input type compiles
    const _ok: Next = (() => {}) as Next
    _ok(onDeposited, {amount: 1})
    // Verify it returns void
    expectTypeOf(_ok(onDeposited, {amount: 1})).toEqualTypeOf<void>()
  })

  it('a context-bearing handler can chain into another handler with the same context', () => {
    type Next = Parameters<typeof onAuditedDeposited.handler>[0]['next']
    const _ok: Next = (() => {}) as Next
    _ok(onAuditedRenamed, {name: 'x'})
  })

  it('rejects chaining a context-free handler from inside a context-bearing handler', () => {
    type Next = Parameters<typeof onAuditedDeposited.handler>[0]['next']
    const _next: Next = (() => {}) as Next
    // @ts-expect-error — onDeposited has Context = undefined, not AuditCtx
    _next(onDeposited, {amount: 1})
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Entity.define — instance/class shape
// ─────────────────────────────────────────────────────────────────────────────

describe('Entity.define instance type', () => {
  it('exposes id, version, props, events, hasMutated', () => {
    const a = new Account()
    expectTypeOf(a.id).toEqualTypeOf<string>()
    expectTypeOf(a.version).toEqualTypeOf<number>()
    expectTypeOf(a.props).toEqualTypeOf<AccountProps>()
    expectTypeOf(a.hasMutated).toEqualTypeOf<boolean>()
    expectTypeOf(a.events).toEqualTypeOf<
      ReadonlyArray<Entity.JournalEvent<string, unknown>>
    >()
  })

  it('exposes a getter named after idField that returns the id string', () => {
    const a = new Account()
    expectTypeOf(a.accountId).toEqualTypeOf<string>()
  })

  it('toStorage() returns a fully-typed StorageValue', () => {
    const a = new Account()
    type Snap = ReturnType<typeof a.toStorage>
    expectTypeOf<Snap['id']>().toEqualTypeOf<string>()
    expectTypeOf<Snap['version']>().toEqualTypeOf<number>()
    expectTypeOf<Snap['props']>().toEqualTypeOf<AccountProps>()
    expectTypeOf<Snap['hasMutated']>().toEqualTypeOf<boolean>()
    expectTypeOf<Snap['events']>().toEqualTypeOf<
      ReadonlyArray<Entity.JournalEvent<string, unknown>>
    >()
  })

  it('cloneProps() returns the props type', () => {
    const a = new Account()
    expectTypeOf(a.cloneProps()).toEqualTypeOf<AccountProps>()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// mutate() typing — payloads, return types, context arg
// ─────────────────────────────────────────────────────────────────────────────

describe('mutate() typing', () => {
  it('requires the qualified event name as a string literal union', () => {
    const a = new Account()
    expectTypeOf(a.mutate)
      .parameter(0)
      .toEqualTypeOf<
        'account.created' | 'account.deposited' | 'account.renamed'
      >()
  })

  // The remaining tests in this block are type-only — they live inside a
  // never-invoked function so the runtime never executes the handlers (which
  // would otherwise crash on missing required props). The directives below
  // are pure compile-time assertions.
  it('locks down mutate signatures via static checks', () => {
    function _typeChecks(account: Account, audited: AuditedAccount) {
      const depositResult = account.mutate('account.deposited', {amount: 1})
      expectTypeOf(depositResult).toEqualTypeOf<{newBalance: number}>()

      const createdResult = account.mutate('account.created', {
        name: 'x',
        tenantId: 't',
      })
      expectTypeOf(createdResult).toEqualTypeOf<void>()

      // Context-free handler: third arg is forbidden.
      account.mutate('account.deposited', {amount: 1})
      account.mutate(
        'account.deposited',
        {amount: 1},
        // @ts-expect-error — context-free handlers reject a third arg
        {something: 'extra'},
      )

      // Context-bearing handler on a mixed entity: third arg required.
      const r = audited.mutate(
        'audited.deposited',
        {amount: 1},
        {tenantId: 't', actor: 'alice'},
      )
      expectTypeOf(r).toEqualTypeOf<{newBalance: number; by: string}>()

      // Context-free handler on the same mixed entity: no third arg allowed.
      audited.mutate('audited.touched', {})
      audited.mutate(
        'audited.touched',
        {},
        // @ts-expect-error — touched has no context
        {tenantId: 't', actor: 'alice'},
      )

      // @ts-expect-error — deposited requires AuditCtx
      audited.mutate('audited.deposited', {amount: 1})

      // @ts-expect-error — wrong context shape
      audited.mutate('audited.deposited', {amount: 1}, {tenantId: 't'})

      // @ts-expect-error — unknown event name
      account.mutate('account.does_not_exist', {})

      // @ts-expect-error — wrong payload shape
      account.mutate('account.deposited', {wrong: 'payload'})
    }
    expectTypeOf(_typeChecks).toBeFunction()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Entity.eventsOf
// ─────────────────────────────────────────────────────────────────────────────

describe('Entity.eventsOf', () => {
  it('builds a discriminated union over all qualified event types', () => {
    type AllEvents = Entity.eventsOf<Account>
    expectTypeOf<AllEvents['type']>().toEqualTypeOf<
      'account.created' | 'account.deposited' | 'account.renamed'
    >()
  })

  it('narrows to a specific event payload when given a qualified name', () => {
    type Deposited = Entity.eventsOf<Account, 'account.deposited'>
    expectTypeOf<Deposited['type']>().toEqualTypeOf<'account.deposited'>()
    expectTypeOf<Deposited['payload']>().toEqualTypeOf<{amount: number}>()
    expectTypeOf<Deposited['version']>().toEqualTypeOf<number>()
    expectTypeOf<Deposited['timestamp']>().toEqualTypeOf<Date>()
    expectTypeOf<Deposited['eventId']>().toEqualTypeOf<string>()
  })

  it('resolves to never for an unknown qualified type', () => {
    type Bogus = Entity.eventsOf<Account, 'account.zzz'>
    expectTypeOf<Bogus>().toEqualTypeOf<never>()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Entity.storageValue
// ─────────────────────────────────────────────────────────────────────────────

describe('Entity.storageValue', () => {
  it('matches the toStorage() return shape', () => {
    type Snap = Entity.storageValue<Account>
    expectTypeOf<Snap['props']>().toEqualTypeOf<AccountProps>()
    expectTypeOf<Snap['id']>().toEqualTypeOf<string>()
    expectTypeOf<Snap['version']>().toEqualTypeOf<number>()
  })

  it('accepts the entity class itself, not just an instance', () => {
    type SnapFromCtor = Entity.storageValue<typeof Account>
    expectTypeOf<SnapFromCtor['props']>().toEqualTypeOf<AccountProps>()
  })

  it('resolves to never for unrelated types', () => {
    type X = Entity.storageValue<{notAnEntity: true}>
    expectTypeOf<X>().toEqualTypeOf<never>()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fromStorage typing
// ─────────────────────────────────────────────────────────────────────────────

describe('fromStorage typing', () => {
  it('returns the subclass instance type, not the base', () => {
    const restored = Account.fromStorage({
      id: 'x',
      version: 1,
      props: {name: 'a', balance: 0, tenantId: 't'},
    })
    expectTypeOf(restored).toEqualTypeOf<Account>()
  })

  it('rejects malformed input statically (compile-time only)', () => {
    function _typeChecks() {
      Account.fromStorage({
        id: 'x',
        version: 1,
        // @ts-expect-error — balance is required
        props: {name: 'a', tenantId: 't'},
      })
    }
    expectTypeOf(_typeChecks).toBeFunction()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Entity.GenericJournalEvent / GenericEntity
// ─────────────────────────────────────────────────────────────────────────────

describe('Generic types', () => {
  it('GenericJournalEvent is JournalEvent<string, unknown>', () => {
    expectTypeOf<Entity.GenericJournalEvent>().toEqualTypeOf<
      Entity.JournalEvent<string, unknown>
    >()
  })

  it('any defined entity is assignable to GenericEntity', () => {
    const a = new Account()
    expectTypeOf(a).toMatchTypeOf<Entity.GenericEntity>()
    const b = new AuditedAccount()
    expectTypeOf(b).toMatchTypeOf<Entity.GenericEntity>()
  })
})
