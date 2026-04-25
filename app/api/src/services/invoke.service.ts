import Ajv, { type ValidateFunction } from "ajv";
import { z } from "zod";

import { logger } from "@/logger";
import type { InvokeRequest, InvokeResponse } from "@/models/invoke.model";
import type { JSONSchema } from "@/models/manifest.model";
import type { AdapterModule } from "@/modules/adapter.module";
import { ManifestService } from "@/services/manifest.service";

const invokeMessageSchema = z.object({
  type: z.literal("invoke.tool"),
  requestId: z.string().min(1),
  serviceName: z.string().min(1),
  toolName: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
});

export interface ProcessMessageChannel {
  on(event: "message", listener: (message: unknown) => void): this;
  off(event: "message", listener: (message: unknown) => void): this;
  send?: (message: InvokeResponse) => boolean;
}

interface ProcessMessageSystemOptions {
  manifestService?: Pick<ManifestService, "getTool">;
}

let hasWarnedMissingChannelSend = false;

export function createProcessMessageSystem(
  adapterModule: AdapterModule,
  channel: ProcessMessageChannel = process,
  options: ProcessMessageSystemOptions = {},
): () => void {
  const manifestService = options.manifestService ?? new ManifestService();
  const validator = new SchemaValidator();

  if (typeof channel.send !== "function" && !hasWarnedMissingChannelSend) {
    hasWarnedMissingChannelSend = true;
    logger.warn(
      "createProcessMessageSystem configured with a channel that has no send(). onMessage will still call handleInvokeMessage, but invoke responses cannot be delivered.",
    );
  }

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

    if (!tool.serviceEnabled) {
      throw new Error(
        `Service '${message.serviceName}' is disabled and cannot be invoked.`,
      );
    }

    if (!tool.tool.enabled) {
      throw new Error(
        `Tool '${message.toolName}' in service '${message.serviceName}' is disabled and cannot be invoked.`,
      );
    }

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
      type: "invoke.response",
      requestId: message.requestId,
      output,
    });
  } catch (error) {
    channel.send?.({
      type: "invoke.error",
      requestId: message.requestId,
      message:
        error instanceof Error
          ? error.message
          : String(error ?? "Unknown error"),
    });
  }
}

function isInvokeMessage(message: unknown): message is InvokeRequest {
  return invokeMessageSchema.safeParse(message).success;
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
