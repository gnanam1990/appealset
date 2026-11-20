/** Domain error carrying an HTTP status and an operator-actionable code. */
export class DomainError extends Error {
  status: number;
  code: string;
  detail: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const badRequest = (msg: string, detail?: Record<string, unknown>) =>
  new DomainError(400, 'bad_request', msg, detail);
export const unauthorized = (msg = 'actor authentication required') =>
  new DomainError(401, 'unauthorized', msg);
export const forbidden = (msg: string, detail?: Record<string, unknown>) =>
  new DomainError(403, 'forbidden', msg, detail);
export const notFound = (msg = 'resource not found') =>
  new DomainError(404, 'not_found', msg);
export const conflict = (msg: string, detail?: Record<string, unknown>) =>
  new DomainError(409, 'conflict', msg, detail);
export const gone = (msg: string, detail?: Record<string, unknown>) =>
  new DomainError(410, 'gone', msg, detail);
export const unprocessable = (msg: string, detail?: Record<string, unknown>) =>
  new DomainError(422, 'unprocessable', msg, detail);
