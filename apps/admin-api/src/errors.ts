export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export class OperationError extends Error {
  constructor(public code: string, public superseded = false) { super(code); }
}
