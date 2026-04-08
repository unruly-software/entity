import { ZodError } from 'zod'

/**
 * Thrown by `entity.mutate(type, ...)` when `type` does not correspond to
 * any registered event handler.
 *
 * @example
 * try {
 *   account.mutate('account.never_defined' as any, {})
 * } catch (err) {
 *   if (err instanceof EntityUnknownEventError) console.warn(err.eventType)
 * }
 */
export class EntityUnknownEventError extends Error {
  readonly entityName: string = ''
  readonly eventType: string = ''

  constructor(entityName: string, eventType: string) {
    super(
      `Entity "${entityName}" has no handler for event type "${eventType}".`,
    )
    this.name = 'EntityUnknownEventError'
    this.entityName = entityName
    this.eventType = eventType
  }
}

/**
 * Thrown when an event handler runs successfully but the resulting props
 * fail the entity's schema validation. The original `ZodError` is exposed
 * via `.zodError`.
 *
 * @example
 * try {
 *   account.mutate('account.withdrawn', {amount: 999_999})
 * } catch (err) {
 *   if (err instanceof EntityValidationError) console.warn(err.zodError)
 * }
 */
export class EntityValidationError extends Error {
  readonly entityName: string = ''
  readonly eventType: string = ''
  readonly zodError: ZodError = null as any

  constructor(entityName: string, eventType: string, zodError: ZodError) {
    super(
      `Entity "${entityName}" entered an invalid state after applying "${eventType}": ${zodError.message}`,
    )
    this.name = 'EntityValidationError'
    this.entityName = entityName
    this.eventType = eventType
    this.zodError = zodError
  }
}
