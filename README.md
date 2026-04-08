<div align="center">
  <h1>@unruly-software/entity</h1>
</div>

<div align="center">

[![Build Status](https://github.com/unruly-software/entity/workflows/Build/badge.svg)](https://github.com/unruly-software/entity/actions)
[![npm version](https://badge.fury.io/js/%40unruly-software%2Fentity.svg)](https://badge.fury.io/js/%40unruly-software%2Fentity)
[![Coverage Status](https://coveralls.io/repos/github/unruly-software/entity/badge.svg?branch=master)](https://coveralls.io/github/unruly-software/entity?branch=master)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js LTS](https://img.shields.io/node/v/@unruly-software/entity.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue.svg)](https://www.typescriptlang.org/)

</div>

A small TypeScript library for modelling [domain
entities](https://martinfowler.com/bliki/EvansClassification.html) in
**event-driven** systems on top of [Zod](https://zod.dev/) schemas. Define
props and events once, get runtime validation, an atomic mutation lifecycle
that rolls back on invariant violations, a journal of domain events, and a
`class` you can attach methods to — without decorators or `reflect-metadata`.

```typescript
class Account extends Entity.define(
  {name: 'account', idField: 'accountId', schema: () => accountPropsSchema},
  [onCreated, onDeposited, onWithdrawn],
) {}

const account = new Account()
account.mutate('account.created', {name: 'Operating', bsb: '062000', accountNumber: '12345678', tenantId: 'tenant-1'})
account.mutate('account.deposited', {amount: 250})

account.version       // 2
account.props.balance // 250
account.events        // [{type: 'account.created', ...}, {type: 'account.deposited', ...}]
```

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Why this design](#why-this-design)
- [Core concepts](#core-concepts)
- [Comparison](#comparison)
- [API reference](#api-reference)
- [License](#license)

## Installation

```bash
npm install @unruly-software/entity zod
```

Zod v4 is the only peer dependency.

## Quick start

```typescript
import {Entity} from '@unruly-software/entity'
import {z} from 'zod'

const accountPropsSchema = z.object({
  name: z.string().min(1),
  balance: z.number().min(0),
  tenantId: z.string().min(1),
})

const onCreated = Entity.defineEvent(accountPropsSchema, 'created', {
  schema: () => z.object({name: z.string().min(1), tenantId: z.string().min(1)}),
  mutate: ({event, props}) => {
    props.name = event.name
    props.tenantId = event.tenantId
    props.balance = 0
  },
})

const onDeposited = Entity.defineEvent(accountPropsSchema, 'deposited', {
  schema: () => z.object({amount: z.number().positive()}),
  mutate: ({event, props}) => {
    props.balance += event.amount
    return {newBalance: props.balance}
  },
})

class Account extends Entity.define(
  {name: 'account', idField: 'accountId', schema: () => accountPropsSchema},
  [onCreated, onDeposited],
) {
  get displayName() {
    return `${this.props.name} (${this.props.tenantId})`
  }
}

const account = new Account()
account.mutate('account.created', {name: 'Operating', tenantId: 'tenant-1'})
const result = account.mutate('account.deposited', {amount: 250})
result // { newBalance: 250 }
```

## Why this design

- **State validation per mutation.** The props schema re-runs after every handler. Failures roll back the entire mutation — props, version, journal — and throw `EntityValidationError`.
- **Schemas, not decorators.** No `reflect-metadata`, no `experimentalDecorators`. Schemas are plain Zod values you can reuse anywhere Zod is accepted.
- **Typed event chaining.** `next(handler, payload)` allows you to run follow-up events in the same mutation.
- **Real classes.** `Entity.define(...)` returns a class you `extends` to attach domain methods. `instanceof` works, and `Entity.GenericEntity` lets you write generic helpers without giving up runtime checks.

## Core concepts

### Defining an entity

`Entity.define(config, handlers)` returns a class. Extend it to attach methods.

```typescript
class Account extends Entity.define(
  {name: 'account', idField: 'accountId', schema: () => accountPropsSchema},
  [onCreated, onDeposited],
) {
  get displayName() { return `${this.props.name} (${this.props.tenantId})` }
}
```

- `name` — aggregate name. Prefixed onto every event short name (`'account'` + `'created'` → `'account.created'`).
- `idField` — public alias for `id`. `account.accountId` reads through to `account.id`.
- `schema` — thunk returning the props schema. Lazy so circular imports work.

### Defining event handlers

```typescript
const onDeposited = Entity.defineEvent(accountPropsSchema, 'deposited', {
  schema: () => z.object({amount: z.number().positive()}),
  mutate: ({event, props}) => {
    props.balance += event.amount
    return {newBalance: props.balance}
  },
})
```

The first argument is the schema of the entity. The handler receives `{event,
props, next, timestamp, version, context}` and may return any value. Mutating
the props provided is expected.

### Mutating

```typescript
const account = new Account()
account.mutate('account.created', {name: 'Operating', tenantId: 'tenant-1'})
const {newBalance} = account.mutate('account.deposited', {amount: 250})
```

`mutate(type, payload)` is fully typed against the registered handlers. Typo'd event names and wrong payload shapes are compile errors.

### Chaining with `next`

A handler can queue follow-up events with `next(handler, payload)`. The handler is a typed reference, not a string:

```typescript
mutate: ({event, props, next}) => {
  props.balance = 0
  if (event.openingBalance) next(onDeposited, {amount: event.openingBalance})
}
```

Chained events commit serially, each at their own version, each running their own payload validation and props schema check. See the Quick Start for the full pattern.

### Validation and rollback

A mutation either commits cleanly *and* leaves the entity satisfying its schema, or it commits nothing.

```typescript
try {
  account.mutate('account.withdrawn', {amount: 250}) // would drive balance < 0
} catch (err) {
  err instanceof Entity.EntityValidationError // true
  err.zodError                                // the underlying ZodError
}
account.version       // unchanged
account.props.balance // unchanged
```

For each event the lifecycle is: parse payload → clone props → run handler → re-parse props through entity schema → commit (or throw and discard).

### Storage

`toStorage()` returns a plain snapshot; `fromStorage(...)` parses props back through the schema so malformed snapshots fail at load time.

```typescript
const snapshot = account.toStorage()
db.write(snapshot)
account.reset() // clear the in-memory journal after a successful persist

const restored = Account.fromStorage(db.read(id))
```

`fromStorage` uses polymorphic `this`, so a subclass call returns the subclass instance.

### Per-mutation context

`Entity.withContext<C>()` returns a builder that pins a context type onto the handlers it produces. The context is destructured from the same input object as `event`/`props` and is required as the third arg to `mutate(...)`.

```typescript
const Audited = Entity.withContext<{tenantId: string; actor: string}>()

const onDeposited = Audited.defineEvent(accountPropsSchema, 'deposited', {
  schema: () => z.object({amount: z.number().positive()}),
  mutate: ({event, props, context}) => {
    props.balance += event.amount
    audit(context.actor, context.tenantId)
  },
})

account.mutate('account.deposited', {amount: 250}, {tenantId: 't1', actor: 'alice'})
```

Context-bearing and context-free handlers can be mixed in one entity; the third arg is required (or forbidden) per handler. Context is forwarded to chained `next()` calls.

### Type-erased helpers

`Entity.GenericEntity` is the runtime base class every entity extends. Use it as a parameter type for generic helpers — `mutate` is intentionally not exposed on it, so a generic helper can't accidentally call into a typed mutation path.

```typescript
function persist(entity: Entity.GenericEntity) {
  if (!entity.hasMutated) return
  db.write(entity.toStorage())
  entity.reset()
}
```

`Entity.GenericJournalEvent` is `JournalEvent<string, unknown>` — the type-erased shape of any committed event, useful for audit/log helpers.

### Custom cloning

Before each handler runs, `cloneProps()` produces a clone the handler can
mutate freely. The default implementation dispatches in this order: primitives and
functions are returned as-is → values with a callable `.clone()` method
delegate to it (the value-object hook) → arrays and plain objects are recursed
→ everything else (`Date`, `Map`, `Set`, `RegExp`, typed arrays) falls through
to `structuredClone`.

⚠️ **Class instances without `.clone()` will throw `DataCloneError`** unless they're structured-cloneable. Either add a `clone()` method or override `cloneProps()`:

```typescript
class Account extends Entity.define(/* ... */) {
  override cloneProps() {
    return {...this.props} // shallow is enough if nothing nested is mutated
  }
}
```

The override runs once per committed event (including each chained event), so keep it cheap.

### Type inference

- `Entity.eventsOf<E>` — discriminated union of every committed `JournalEvent` for the entity. Pass a second qualified-name argument to narrow to one event.
- `Entity.storageValue<E>` — the shape returned by `toStorage()`.

Both helpers accept either the class type (`typeof Account`) or the instance type (`Account`).

## Comparison

This library sits between Zod-driven validation and class-based domain modelling. It's **event-driven**, not event-sourced: state is stored directly, events are published as a side effect.

| Library | Paradigm | Runtime validation | State validation per mutation | Event chaining | Storage round-trip | Class methods |
|---|---|---|---|---|---|---|
| **@unruly-software/entity** | Event-driven | Zod (events + props) | **Yes** | Type-safe `next(handler, payload)` | Built-in | Yes |
| Hand-rolled DDD aggregate | Either | DIY | Manual | Ad-hoc | Manual | Yes |
| [@nestjs/cqrs](https://docs.nestjs.com/recipes/cqrs) `AggregateRoot` | Either | None | None | `apply(event)` strings | Manual | Yes |
| [Effect Schema](https://effect.website/docs/schema/classes/) `Schema.Class` | State-only | Effect Schema | n/a | n/a | `Schema.encode/decode` | Yes |
| [class-validator](https://github.com/typestack/class-validator) + [class-transformer](https://github.com/typestack/class-transformer) | State-only | Decorator-driven | None | n/a | `instanceToPlain` / `plainToInstance` | Yes |
| [@resourge/event-sourcing](https://github.com/resourge/resourge/tree/main/packages/event-sourcing) | Event-sourced | None | None | Reducers | Replay | No |
| [EventStoreDB JS client](https://github.com/EventStore/EventStore-Client-NodeJS) | Event-sourced | None | None | n/a | Replay | n/a |

Pick this library if you want type-safe, schema-validated domain entities with built-in event emission for an event-driven architecture. Pick a dedicated event-sourcing platform if events need to be your durable source of truth.

If you care deeply about milliseconds and allocation overhead, this library is
not for you. We prioritize correctness, maintainability, and DX over raw speed
since CPU cycles are not usually the bottleneck in systems we've built. If you
need a high-performance solution, take this library as inspiration rather than
a drop-in.

Personally we find falling back to bulk database objects and plain object
mutations with good testing works better for improving high throughput hotspots
than micro-optimising the business layer.

## API reference

### `Entity.define(config, handlers)`

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Aggregate name. Prefixed onto every event short name. |
| `idField` | `string` | Public alias for `id` (e.g. `'accountId'`). |
| `schema` | `() => ZodSchema` | Lazy props schema. |
| `handlers` | `DefinedEvent[]` | Array of handlers from `Entity.defineEvent(...)`. |

### `Entity.defineEvent(modelSchema, shortName, config)`

| Argument | Type | Description |
|---|---|---|
| `modelSchema` | `ZodSchema \| () => ZodSchema` | Pins the props type at the type level. Not used at runtime. |
| `shortName` | `string` | Un-prefixed event name. |
| `config.schema` | `() => ZodSchema` | Lazy event payload schema. |
| `config.mutate` | `(input) => RT` | Handler. Mutates `input.props`, may call `input.next(...)`, may return a value. |

### `Entity.withContext<C>()`

Returns `{defineEvent}` whose handlers receive a typed `context: C` field. Calling `entity.mutate(type, payload, context)` requires the third argument iff the matched handler was defined this way.

### Instance members

| Member | Description |
|---|---|
| `props` | Validated current state. |
| `id` / `[idField]` | Aggregate id, plus the ergonomic alias from config. |
| `version` | Monotonically increasing version. |
| `events` | Read-only journal entries committed since construction or last `reset()`. |
| `hasMutated` | `events.length > 0`. |
| `mutate(type, payload, context?)` | Run a handler. Statically typed against registered handlers. Returns the handler's return value. |
| `toStorage()` | Snapshot to a plain object. |
| `reset()` | Clear the journal. |
| `cloneProps()` | Deep-clone the current props. Override to customise. |

### Static members

| Member | Description |
|---|---|
| `aggregateName` | The `name` from config. |
| `idField` | The `idField` from config. |
| `schema()` | The entity's Zod schema. |
| `fromStorage(state)` | Construct from a snapshot. Parses `props` through the schema. Polymorphic `this`. |

### Errors

| Class | Thrown when |
|---|---|
| `EntityUnknownEventError` | `mutate(type, ...)` is called with an unregistered `type`. |
| `EntityValidationError` | A handler runs but the resulting props fail the entity schema. Wraps the `ZodError` on `.zodError`. |

### Type helpers

| Helper | Resolves to |
|---|---|
| `Entity.eventsOf<E>` | Discriminated union of all `JournalEvent`s for the entity. |
| `Entity.eventsOf<E, K>` | A single `JournalEvent` narrowed by qualified type name. |
| `Entity.storageValue<E>` | The `StorageValue<P>` shape returned by `toStorage()`. |
| `Entity.GenericEntity` | Runtime base class every entity extends. |
| `Entity.GenericJournalEvent` | `JournalEvent<string, unknown>`  type-erased committed event. |

## License

MIT -- see [LICENSE](LICENSE).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes.
