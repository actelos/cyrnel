export interface InvokeRequestMessage {
  type: "process.invoke";
  requestId: string;
  serviceId: string;
  toolId: string;
  parameters: Record<string, unknown>;
}

export type InvokeMessage = InvokeRequestMessage;

export interface InvokeResponseMessage {
  type: "process.response";
  requestId: string;
  output: unknown;
}

export interface InvokeErrorResponseMessage {
  type: "process.error";
  requestId: string;
  error: {
    message: string;
  };
}

export type InvokeMessageResponse =
  | InvokeResponseMessage
  | InvokeErrorResponseMessage;
