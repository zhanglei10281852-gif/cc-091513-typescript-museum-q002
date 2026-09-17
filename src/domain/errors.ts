// 可预期的业务错误，HTTP 层映射为对应状态码；其余错误按 500 处理。

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 422,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const invalidInput = (
  code: string,
  message: string,
  details?: unknown,
): DomainError => new DomainError(code, message, 400, details);

export const conflict = (
  code: string,
  message: string,
  details?: unknown,
): DomainError => new DomainError(code, message, 409, details);

export const notFound = (
  code: string,
  message: string,
  details?: unknown,
): DomainError => new DomainError(code, message, 404, details);

export const forbidden = (
  code: string,
  message: string,
): DomainError => new DomainError(code, message, 403);
