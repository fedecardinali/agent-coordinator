export class CoordinatorError extends Error {
  readonly code: string;

  constructor(message: string, code = "COORDINATOR_ERROR") {
    super(message);
    this.name = "CoordinatorError";
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
