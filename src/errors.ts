/** 统一业务错误：账本层抛出，HTTP 层据此生成一致的错误响应。 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }

  static notFound(what: string, key: string): AppError {
    return new AppError(404, "not_found", `${what}不存在: ${key}`);
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError(400, "validation_failed", message, details);
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError(409, "conflict", message, details);
  }

  static invalidState(message: string, details?: unknown): AppError {
    return new AppError(409, "invalid_state", message, details);
  }

  static unauthenticated(): AppError {
    return new AppError(401, "unauthenticated", "写操作需要 x-actor-id 请求头");
  }

  static forbidden(message = "当前角色没有执行该操作的权限"): AppError {
    return new AppError(403, "forbidden", message);
  }
}
