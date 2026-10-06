export interface ErrorResponse {
  error: string;
  code?: string;
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
    public readonly approvalId?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
