export class DomainError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DomainError";
  }
}

export class InvalidDomainValueError extends DomainError {
  constructor(field: string, value: unknown) {
    super(`Invalid domain value for ${field}: ${String(value)}`);
    this.name = "InvalidDomainValueError";
  }
}

export class EntityNotFoundError extends DomainError {
  constructor(entity: string, identifier: string) {
    super(`${entity} not found: ${identifier}`);
    this.name = "EntityNotFoundError";
  }
}
