import Ajv, { type ValidateFunction } from "ajv";
import type {
  InvokeRequest,
  InvokeResponse,
} from "@/models/invoke.model";
import type { JSONSchema } from "@/models/manifest.model";
import type { AdapterModule } from "@/modules/adapter.module";
import { ManifestService } from "@/services/manifest.service";

export interface ProcessMessageChannel {
  on(event: "message", listener: (message: unknown) => void): this;
  off(event: "message", listener: (message: unknown) => void): this;
  send?: (message: InvokeResponse) => boolean;
}

interface ProcessMessageSystemOptions {
  manifestService?: Pick<ManifestService, "getTool">;
}

export function createProcessMessageSystem(
  adapterModule: AdapterModule,
  channel: ProcessMessageChannel = process,
  options: ProcessMessageSystemOptions = {},
): () => void {
  const manifestService = options.manifestService ?? new ManifestService();
  const validator = new SchemaValidator();

  const onMessage = (message: unknown) => {
    void handleInvokeMessage(
      adapterModule,
      channel,
      manifestService,
      validator,
      message,
    );
  };

  channel.on("message", onMessage);

  return () => {
    channel.off("message", onMessage);
  };
}

async function handleInvokeMessage(
  adapterModule: AdapterModule,
  channel: ProcessMessageChannel,
  manifestService: Pick<ManifestService, "getTool">,
  validator: SchemaValidator,
  message: unknown,
): Promise<void> {
  if (!isInvokeMessage(message)) {
    return;
  }

  try {
    const tool = await manifestService.getTool(
      message.serviceName,
      message.toolName,
    );
    validator.validate(
      tool.tool.inputSchema,
      message.parameters,
      `Invalid invoke parameters for tool '${message.toolName}'.`,
    );

    const output = await adapterModule.invoke(
      message.toolName,
      message.parameters,
      {
        serviceMetadata: tool.serviceMetadata,
        toolMetadata: tool.tool.metadata,
      },
    );

    validator.validate(
      tool.tool.outputSchema,
      output,
      `Invalid invoke output for tool '${message.toolName}'.`,
    );

    channel.send?.({
      type: "tool.response",
      requestId: message.requestId,
      output,
    });
  } catch (error) {
    channel.send?.({
      type: "tool.error",
      requestId: message.requestId,
      error: {
        message:
          error instanceof Error
            ? error.message
            : String(error ?? "Unknown error"),
      },
    });
  }
}

function isInvokeMessage(message: unknown): message is InvokeRequest {
  if (!message || typeof message !== "object") {
    return false;
  }

  const candidate = message as Partial<InvokeRequest>;

  return (
    candidate.type === "tool.invoke" &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0 &&
    typeof candidate.serviceName === "string" &&
    candidate.serviceName.length > 0 &&
    typeof candidate.toolName === "string" &&
    candidate.toolName.length > 0 &&
    !!candidate.parameters &&
    typeof candidate.parameters === "object" &&
    !Array.isArray(candidate.parameters)
  );
}

class SchemaValidator {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly validators = new Map<string, ValidateFunction>();

  validate(schema: JSONSchema, payload: unknown, message: string): void {
    const validate = this.getValidator(schema);
    const valid = validate(payload);

    if (valid) {
      return;
    }

    const details =
      validate.errors
        ?.map((error) => {
          const location = error.instancePath || "/";
          return `${location} ${error.message}`.trim();
        })
        .join("; ") ?? "Schema validation failed.";

    throw new Error(`${message} ${details}`);
  }

  private getValidator(schema: JSONSchema): ValidateFunction {
    const key = JSON.stringify(schema);
    const cached = this.validators.get(key);

    if (cached) {
      return cached;
    }

    const compiled = this.ajv.compile(schema);
    this.validators.set(key, compiled);
    return compiled;
  }
}
