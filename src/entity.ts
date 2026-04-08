import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DefinedEvent, NextFn } from './define-event'
import { EntityUnknownEventError, EntityValidationError } from './errors'
import { deepClone, once } from './utils'

/**
 * A committed event in an entity's journal.
 *
 * @example
 * const onCreated: JournalEvent<'account.created', {name: string}> = {
 *   eventId: 'a1b2',
 *   version: 1,
 *   timestamp: new Date(),
 *   type: 'account.created',
 *   payload: {name: 'Operating'},
 * }
 */
export interface JournalEvent<Type extends string = string, Payload = unknown> {
  eventId: string
  version: number
  timestamp: Date
  type: Type
  payload: Payload
}

/**
 * Type-erased journal event. Use this in function signatures that handle
 * "any committed event from any entity".
 *
 * @example
 * function audit(event: GenericJournalEvent) {
 *   log.info({type: event.type, version: event.version})
 * }
 */
export type GenericJournalEvent = JournalEvent<string, unknown>

/**
 * State shape accepted by the entity constructor. Prefer
 * `EntityClass.fromStorage(...)` for loading; the constructor accepts
 * unvalidated props.
 *
 * @example
 * new Account()                              // fresh, version 0
 * new Account({id: 'x', version: 5, props}) // loaded from storage
 */
export interface EntityState<P> {
  props?: P
  id?: string
  version?: number
}

/**
 * Plain-object snapshot of an entity, returned by `entity.toStorage()`.
 *
 * @example
 * const snapshot: StorageValue<AccountProps> = account.toStorage()
 * db.write({id: snapshot.id, version: snapshot.version, props: snapshot.props})
 */
export interface StorageValue<P> {
  id: string
  version: number
  props: P
  events: ReadonlyArray<JournalEvent>
  hasMutated: boolean
}

/**
 * Extracts the `StorageValue` shape for a given entity class or instance.
 *
 * @example
 * type AccountStorage = Entity.storageValue<Account>
 * // = StorageValue<{ name: string, bsb: string, ... }>
 */
export type storageValue<E> = E extends { props: infer P }
  ? StorageValue<P>
  : E extends { new (...args: any[]): { props: infer P } }
  ? StorageValue<P>
  : never

/**
 * Type-erased base class that every defined entity extends. Direct
 * instantiation is not supported — all methods throw.
 *
 * @example
 * function persist(entity: GenericEntity) {
 *   if (entity.hasMutated) db.save(entity.toStorage())
 * }
 */
export class GenericEntity {
  get id(): string {
    throw new Error(
      'GenericEntity is abstract — extend `Entity.define(...)` instead.',
    )
  }
  get version(): number {
    throw new Error('GenericEntity is abstract')
  }
  get props(): unknown {
    throw new Error('GenericEntity is abstract')
  }
  get events(): ReadonlyArray<JournalEvent> {
    throw new Error('GenericEntity is abstract')
  }
  get hasMutated(): boolean {
    throw new Error('GenericEntity is abstract')
  }
  reset(): void {
    throw new Error('GenericEntity is abstract')
  }
  toStorage(): StorageValue<unknown> {
    throw new Error('GenericEntity is abstract')
  }
  cloneProps(): unknown {
    throw new Error('GenericEntity is abstract')
  }
}

/** Type-only brand carrying the entity's name and handlers tuple. */
declare const ENTITY_BRAND: unique symbol

export interface EntityBrand<
  Name extends string,
  Handlers extends ReadonlyArray<DefinedEvent<any, any, any, any, any, any>>,
> {
  readonly [ENTITY_BRAND]: { name: Name; handlers: Handlers }
}

/** Maps a tuple of `DefinedEvent`s to a record keyed by qualified type name. */
export type HandlersByQualifiedName<
  Name extends string,
  Handlers extends ReadonlyArray<DefinedEvent<any, any, any, any, any, any>>,
> = {
  [H in Handlers[number] as `${Name}.${H['shortName']}`]: H
}

/** Extracts the `Context` type slot from a `DefinedEvent`. */
export type ContextOf<H> = H extends DefinedEvent<
  any,
  any,
  any,
  any,
  any,
  infer C
>
  ? C
  : never

/**
 * Extracts a discriminated union of all journal events for an entity, or a
 * single event when narrowed by qualified type name.
 *
 * @example
 * type AllUserEvents = Entity.eventsOf<User>
 * type UserCreated = Entity.eventsOf<User, 'user.created'>
 */
export type eventsOf<E, K extends string = string> = E extends EntityBrand<
  infer Name,
  infer Handlers
>
  ? {
      [Q in keyof HandlersByQualifiedName<Name, Handlers> &
        K]: HandlersByQualifiedName<Name, Handlers>[Q] extends DefinedEvent<
        any,
        any,
        infer Payload,
        any,
        any,
        any
      >
        ? JournalEvent<Q & string, Payload>
        : never
    }[keyof HandlersByQualifiedName<Name, Handlers> & K]
  : never

/**
 * The instance shape of an entity class produced by `Entity.define(...)`.
 *
 * The `EntityBrand` mixin is a phantom type-only marker — it does not exist
 * at runtime. It carries the entity name and the handlers tuple so that
 * `Entity.eventsOf<T>` can recover them.
 */
/** Instance shape of an entity class produced by `Entity.define(...)`. */
export type EntityInstance<
  Name extends string,
  IdField extends string,
  PSchema extends z.ZodType,
  Handlers extends ReadonlyArray<
    DefinedEvent<z.output<PSchema>, any, any, any, any, any>
  >,
> = Omit<GenericEntity, 'props' | 'events' | 'toStorage' | 'cloneProps'> & {
  readonly props: z.output<PSchema>
  readonly events: ReadonlyArray<JournalEvent>
  toStorage(): StorageValue<z.output<PSchema>>
  cloneProps(): z.output<PSchema>
  mutate<K extends keyof HandlersByQualifiedName<Name, Handlers> & string>(
    type: K,
    payload: HandlersByQualifiedName<Name, Handlers>[K] extends DefinedEvent<
      any,
      any,
      any,
      infer In,
      any,
      any
    >
      ? In
      : never,
    ...rest: [ContextOf<HandlersByQualifiedName<Name, Handlers>[K]>] extends [
      undefined,
    ]
      ? []
      : [context: ContextOf<HandlersByQualifiedName<Name, Handlers>[K]>]
  ): HandlersByQualifiedName<Name, Handlers>[K] extends DefinedEvent<
    any,
    any,
    any,
    any,
    infer RT,
    any
  >
    ? RT
    : never
} & EntityBrand<Name, Handlers> & {
    readonly [P in IdField]: string
  }

export interface EntityConstructor<
  Name extends string,
  IdField extends string,
  PSchema extends z.ZodType,
  Handlers extends ReadonlyArray<
    DefinedEvent<z.output<PSchema>, any, any, any, any, any>
  >,
> {
  new (state?: EntityState<z.output<PSchema>>): EntityInstance<
    Name,
    IdField,
    PSchema,
    Handlers
  >

  readonly aggregateName: Name
  readonly idField: IdField
  schema(): PSchema

  /**
   * Construct an entity from a persisted snapshot. Parses `props` through
   * the entity's Zod schema, so a malformed payload throws at the
   * persistence boundary.
   *
   * @example
   * const account = Account.fromStorage({
   *   id: 'abc',
   *   version: 7,
   *   props: dbRow.state,
   * })
   */
  fromStorage<C extends new (state?: EntityState<z.output<PSchema>>) => any>(
    this: C,
    state: { id: string; version: number; props: z.input<PSchema> },
  ): InstanceType<C>
}

/**
 * Creates an entity class backed by a Zod props schema and typed event
 * handlers. Extend the returned class to add domain methods.
 *
 * @example
 * class Account extends Entity.define(
 *   {name: 'account', idField: 'accountId', schema: () => accountSchema},
 *   [onCreated, onDeposited, onWithdrawn],
 * ) {
 *   get displayName() {
 *     return `${this.props.name} (${this.props.bsb})`
 *   }
 * }
 *
 * const account = new Account()
 * account.mutate('account.created', {name: 'Operating', ...})
 */
export function define<
  Name extends string,
  IdField extends string,
  PSchema extends z.ZodType,
  Handlers extends ReadonlyArray<
    DefinedEvent<z.output<PSchema>, any, any, any, any, any>
  >,
>(
  config: {
    name: Name
    idField: IdField
    schema: () => PSchema
  },
  handlers: Handlers,
): EntityConstructor<Name, IdField, PSchema, Handlers> {
  const getSchema = once(config.schema)

  const handlerMap = new Map<
    string,
    DefinedEvent<z.output<PSchema>, string, unknown, unknown, unknown, unknown>
  >()
  for (const handler of handlers) {
    const qualified = `${config.name}.${handler.shortName}`
    if (handlerMap.has(qualified)) {
      throw new Error(
        `Duplicate event handler "${qualified}" registered on entity "${config.name}".`,
      )
    }
    handlerMap.set(
      qualified,
      handler as DefinedEvent<
        z.output<PSchema>,
        string,
        unknown,
        unknown,
        unknown,
        unknown
      >,
    )
  }

  type Props = z.output<PSchema>

  interface QueuedEvent {
    qualifiedType: string
    handler: DefinedEvent<Props, string, unknown, unknown, unknown, unknown>
    rawPayload: unknown
  }

  const DefinedEntity = class extends GenericEntity {
    private _props: Props = {} as Props
    private _id: string = ''
    private _version: number = 0
    private _events: JournalEvent[] = []
    private _loadedFromStorage: boolean = false

    static readonly aggregateName: Name = config.name
    static readonly idField: IdField = config.idField
    static schema(): PSchema {
      return getSchema()
    }

    /**
     * Construct an entity from a persisted snapshot. Parses `props`
     * through the schema; subclasses inherit polymorphic `this`.
     *
     * @example
     * const account = Account.fromStorage({id, version, props})
     */
    static fromStorage(
      this: any,
      state: {
        id: string
        version: number
        props: unknown
      },
    ) {
      const parsedProps = getSchema().parse(state.props) as Props
      const Ctor = this as new (s: EntityState<Props>) => unknown
      return new Ctor({
        id: state.id,
        version: state.version,
        props: parsedProps,
      })
    }

    constructor(state: EntityState<Props> = {}) {
      super()
      this._props = (state.props ?? ({} as Props)) as Props
      this._id = state.id ?? randomUUID()
      this._version = state.version ?? 0
      this._loadedFromStorage = this._version > 0
    }

    get props(): Props {
      return this._props
    }

    get id(): string {
      return this._id
    }

    get version(): number {
      return this._version
    }

    get events(): ReadonlyArray<JournalEvent> {
      return this._events
    }

    get hasMutated(): boolean {
      return this._events.length > 0
    }

    /**
     * Snapshot the entity for persistence. The result contains everything
     * `fromStorage(...)` needs to rehydrate.
     *
     * @example
     * const snapshot = account.toStorage()
     * db.write(snapshot)
     */
    toStorage(): StorageValue<Props> {
      return {
        id: this._id,
        version: this._version,
        props: this._props,
        events: this._events,
        hasMutated: this._events.length > 0,
      }
    }

    /**
     * Clear the journal and mark the entity as loaded-from-storage.
     *
     * @example
     * await db.persist(account.toStorage())
     * account.reset()
     */
    reset(): void {
      this._events = []
      this._loadedFromStorage = true
    }

    /**
     * Deep-clone the current props before each handler runs. Override
     * in a subclass for performance or for exotic types that the
     * default `deepClone` can't handle.
     *
     * @example
     * class Account extends Entity.define(...) {
     *   override cloneProps() {
     *     return {...this.props}
     *   }
     * }
     */
    cloneProps(): Props {
      return deepClone(this._props)
    }

    /**
     * Apply an event handler. Statically typed against the registered
     * handlers; returns the handler's return value.
     *
     * @example
     * account.mutate('account.created', {name: 'Operating', ...})
     * const result = account.mutate('account.deposited', {amount: 250})
     * // result is the return value of the deposited handler
     */
    mutate(type: string, payload: unknown, context?: unknown): unknown {
      const initialHandler = handlerMap.get(type)
      if (!initialHandler) {
        throw new EntityUnknownEventError(config.name, type)
      }

      const queue: QueuedEvent[] = [
        { qualifiedType: type, handler: initialHandler, rawPayload: payload },
      ]
      let initialReturnValue: unknown = undefined
      let isFirst = true

      const next: NextFn<Props> = (handler, chainedPayload) => {
        const qualifiedType = `${config.name}.${handler.shortName}`
        const resolved = handlerMap.get(qualifiedType)
        if (!resolved || resolved !== handler) {
          throw new EntityUnknownEventError(config.name, qualifiedType)
        }
        queue.push({
          qualifiedType,
          handler: resolved,
          rawPayload: chainedPayload,
        })
      }

      while (queue.length > 0) {
        const queued = queue.shift()!
        const parsedPayload = queued.handler
          .getSchema()
          .parse(queued.rawPayload)
        const cloned = this.cloneProps()
        const timestamp = new Date()
        const nextVersion = this._version + 1
        const eventId = randomUUID()

        const returnValue = queued.handler.handler({
          event: parsedPayload,
          props: cloned,
          next,
          timestamp,
          version: nextVersion,
          context,
        })

        const validation = getSchema().safeParse(cloned)
        if (!validation.success) {
          throw new EntityValidationError(
            config.name,
            queued.qualifiedType,
            validation.error,
          )
        }

        this._props = validation.data as Props
        this._version = nextVersion
        this._events.push({
          eventId,
          version: nextVersion,
          timestamp,
          type: queued.qualifiedType,
          payload: parsedPayload,
        })

        if (isFirst) {
          initialReturnValue = returnValue
          isFirst = false
        }
      }

      return initialReturnValue
    }
  }

  Object.defineProperty(DefinedEntity.prototype, config.idField, {
    get(this: { id: string }) {
      return this.id
    },
    enumerable: false,
    configurable: true,
  })

  return DefinedEntity as unknown as EntityConstructor<
    Name,
    IdField,
    PSchema,
    Handlers
  >
}
