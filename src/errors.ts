export type ErrorCode = "protocol" | "configuration";

const messages: Record<ErrorCode, string> = {
  protocol: "The service returned a response in an unexpected shape.",
  configuration: "Invalid configuration or input.",
};

export class AtlasError extends Error {
  readonly code: ErrorCode;
  readonly field: string | undefined;

  constructor(code: ErrorCode, field?: string) {
    super(messages[code]);
    this.name = "AtlasError";
    this.code = code;
    this.field = field;
  }
}
