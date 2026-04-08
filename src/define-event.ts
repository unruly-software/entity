import { z } from 'zod'
import { once } from './utils'

/**
 * Function passed to event handlers to chain another typed event onto the
 * current `mutate(...)` call.
 *
 * @example
 * mutate: ({event, props, next}) => {
 *   props.balance = 0
 *   if (event.openingBalance) next(onDeposited, {amount: event.openingBalance})
 * }
 */
export type NextFn<P, Context = undefined> = <
  ChainedShortName extends string,
  ChainedPayload,
  ChainedPayloadInput,
  ChainedRT,
>(
  handler: DefinedEvent<
    P,
    ChainedShortName,
    ChainedPayload,
    ChainedPayloadInput,
    ChainedRT,
    Context
  >,
  payload: ChainedPayloadInput,
) => void

/**
 * Input passed to an event handler's `mutate` function.
 *
 * @example
 * mutate: ({event, props, next, timestamp, version}) => {
 *   props.balance += event.amount
 * }
 */
export interface HandlerInput<P, EventPayload, Context = undefined> {
  event: EventPayload
  props: P
  next: NextFn<P, Context>
  timestamp: Date
  version: number
  context: Context
}

/** Phantom-typed handler descriptor produced by `defineEvent`. */
export interface DefinedEvent<
  P,
  ShortName extends string,
  Payload,
  PayloadInput,
  RT,
  Context = undefined,
> {
  readonly __propsBrand: (p: P) => void
  readonly __contextBrand: (c: Context) => void
  readonly shortName: ShortName
  readonly getSchema: () => z.ZodType<Payload, PayloadInput>
  readonly handler: (input: HandlerInput<P, Payload, Context>) => RT
}

/**
 * Defines a single typed event handler for an entity. The result is passed
 * to `Entity.define([...])`. `modelSchema` is type-only — it pins the props
 * type so all handlers in a `define` call agree on the same `P`.
 *
 * @example
 * const onDeposited = Entity.defineEvent(accountSchema, 'deposited', {
 *   schema: () => z.object({amount: z.number().positive()}),
 *   mutate: ({event, props}) => {
 *     props.balance += event.amount
 *     return {newBalance: props.balance}
 *   },
 * })
 */
export function defineEvent<
  PSchema extends z.ZodType,
  ShortName extends string,
  EventSchema extends z.ZodType,
  RT,
>(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  modelSchema: PSchema | (() => PSchema),
  shortName: ShortName,
  config: {
    schema: () => EventSchema
    mutate: (
      input: HandlerInput<z.output<PSchema>, z.output<EventSchema>>,
    ) => RT
  },
): DefinedEvent<
  z.output<PSchema>,
  ShortName,
  z.output<EventSchema>,
  z.input<EventSchema>,
  RT,
  undefined
> {
  const getSchema = once(config.schema) as () => z.ZodType<
    z.output<EventSchema>,
    z.input<EventSchema>
  >
  return {
    __propsBrand: undefined as unknown as (p: z.output<PSchema>) => void,
    __contextBrand: undefined as unknown as (c: undefined) => void,
    shortName,
    getSchema,
    handler: config.mutate,
  }
}

/**
 * Pin a `Context` type once and produce a `defineEvent` that requires every
 * handler to be invoked with a matching context value.
 *
 * @example
 * const Account = Entity.withContext<{tenantId: string; clock: Clock}>()
 *
 * const onDeposited = Account.defineEvent(accountSchema, 'deposited', {
 *   schema: () => z.object({amount: z.number().positive()}),
 *   mutate: ({event, props, context}) => {
 *     props.balance += event.amount
 *     audit(context.tenantId, context.clock.now())
 *   },
 * })
 *
 * account.mutate('account.deposited', {amount: 250}, {tenantId: 't1', clock})
 */
export function withContext<Context>() {
  return {
    defineEvent<
      PSchema extends z.ZodType,
      ShortName extends string,
      EventSchema extends z.ZodType,
      RT,
    >(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      modelSchema: PSchema | (() => PSchema),
      shortName: ShortName,
      config: {
        schema: () => EventSchema
        mutate: (
          input: HandlerInput<
            z.output<PSchema>,
            z.output<EventSchema>,
            Context
          >,
        ) => RT
      },
    ): DefinedEvent<
      z.output<PSchema>,
      ShortName,
      z.output<EventSchema>,
      z.input<EventSchema>,
      RT,
      Context
    > {
      const getSchema = once(config.schema) as () => z.ZodType<
        z.output<EventSchema>,
        z.input<EventSchema>
      >
      return {
        __propsBrand: undefined as unknown as (p: z.output<PSchema>) => void,
        __contextBrand: undefined as unknown as (c: Context) => void,
        shortName,
        getSchema,
        handler: config.mutate,
      }
    },
  }
}
