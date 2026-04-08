import {describe, expect, it} from 'vitest'
import {z} from 'zod'
import {Entity} from '../src'

const accountPropsSchema = z.object({
  name: z.string().min(1),
  balance: z.number().min(0),
  tenantId: z.string().min(1),
})

interface AuditContext {
  tenantId: string
  actor: string
}

const Audited = Entity.withContext<AuditContext>()

const auditLog: Array<{type: string; actor: string; tenantId: string}> = []

const onDeposited = Audited.defineEvent(accountPropsSchema, 'deposited', {
  schema: () => z.object({amount: z.number().positive()}),
  mutate: ({event, props, context}) => {
    props.balance += event.amount
    auditLog.push({
      type: 'deposited',
      actor: context.actor,
      tenantId: context.tenantId,
    })
    return {newBalance: props.balance}
  },
})

const onCreated = Audited.defineEvent(accountPropsSchema, 'created', {
  schema: () =>
    z.object({
      name: z.string().min(1),
      tenantId: z.string().min(1),
      openingBalance: z.number().min(0).optional(),
    }),
  mutate: ({event, props, next, context}) => {
    props.name = event.name
    props.tenantId = event.tenantId
    props.balance = 0
    auditLog.push({
      type: 'created',
      actor: context.actor,
      tenantId: context.tenantId,
    })
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

class AuditedAccount extends Entity.define(
  {
    name: 'audited',
    idField: 'auditedId',
    schema: () => accountPropsSchema,
  },
  [onCreated, onDeposited, onRenamed],
) {}

describe('Entity.withContext', () => {
  it('passes the typed context to context-bearing handlers', () => {
    auditLog.length = 0
    const account = new AuditedAccount()

    account.mutate(
      'audited.created',
      {name: 'Operating', tenantId: 'tenant-1'},
      {tenantId: 'tenant-1', actor: 'alice'},
    )

    expect(auditLog).toEqual([
      {type: 'created', actor: 'alice', tenantId: 'tenant-1'},
    ])
  })

  it('threads the same context through next()-chained handlers', () => {
    auditLog.length = 0
    const account = new AuditedAccount()

    account.mutate(
      'audited.created',
      {name: 'Operating', tenantId: 'tenant-1', openingBalance: 500},
      {tenantId: 'tenant-1', actor: 'alice'},
    )

    expect(account.props.balance).toBe(500)
    expect(auditLog).toEqual([
      {type: 'created', actor: 'alice', tenantId: 'tenant-1'},
      {type: 'deposited', actor: 'alice', tenantId: 'tenant-1'},
    ])
  })

  it('returns the originating handler value when context is supplied', () => {
    const account = new AuditedAccount()
    account.mutate(
      'audited.created',
      {name: 'Operating', tenantId: 'tenant-1'},
      {tenantId: 'tenant-1', actor: 'alice'},
    )

    const result = account.mutate(
      'audited.deposited',
      {amount: 250},
      {tenantId: 'tenant-1', actor: 'bob'},
    )
    expect(result).toEqual({newBalance: 250})
  })

  it('still allows context-free handlers on the same entity to be called without a context arg', () => {
    const account = new AuditedAccount()
    account.mutate(
      'audited.created',
      {name: 'Operating', tenantId: 'tenant-1'},
      {tenantId: 'tenant-1', actor: 'alice'},
    )

    account.mutate('audited.renamed', {name: 'Renamed'})
    expect(account.props.name).toBe('Renamed')
  })

  it('rejects calls that omit or misuse context at the type level', () => {
    function types(account: AuditedAccount) {
      // @ts-expect-error — context arg is required for context-bearing handlers
      account.mutate('audited.created', {
        name: 'Operating',
        tenantId: 'tenant-1',
      })

      account.mutate(
        'audited.renamed',
        {name: 'Renamed'},
        // @ts-expect-error — renamed handler does not take a context
        {tenantId: 'tenant-1', actor: 'alice'},
      )
    }
  })
})
