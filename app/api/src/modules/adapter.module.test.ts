import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdapterModule, parseServiceManifest } from "@/modules/adapter.module";

describe("AdapterModule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invoke() sends a POST request to the tool endpoint", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    const adapter = new AdapterModule({ fetchImpl });

    await expect(
      adapter.invoke(
        "tool-1",
        { input: "anything" },
        {
          serviceMetadata: {
            url: "http://127.0.0.1:9999",
          },
          toolMetadata: {},
        },
      ),
    ).resolves.toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/tool-1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ input: "anything" }),
      }),
    );
  });

  it("invoke() uses manifest metadata for server URL and tool route", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    const adapter = new AdapterModule({ fetchImpl });

    await adapter.invoke(
      "tool-1",
      { input: "anything" },
      {
        serviceMetadata: {
          serverUrl: "http://adapter.example:8080/api",
        },
        toolMetadata: {
          route: "invoke/echo",
        },
      },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://adapter.example:8080/api/invoke%2Fecho",
      expect.any(Object),
    );
  });

  it("invoke() attaches request-kind header from tool metadata", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    const adapter = new AdapterModule({ fetchImpl });

    await adapter.invoke(
      "tool-1",
      { input: "anything" },
      {
        serviceMetadata: {
          url: "http://127.0.0.1:9999",
        },
        toolMetadata: {
          requestKind: "rpc.invoke",
        },
      },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/tool-1",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-mci-request-kind": "rpc.invoke",
        }),
      }),
    );
  });

  it("invoke() returns wrapped output payloads", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output: "hello world" })),
      );
    const adapter = new AdapterModule({ fetchImpl });

    await expect(
      adapter.invoke(
        "tool-1",
        { input: "anything" },
        {
          serviceMetadata: {
            url: "http://127.0.0.1:9999",
          },
          toolMetadata: {},
        },
      ),
    ).resolves.toBe("hello world");
  });

  it("invoke() throws for non-2xx responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "tool not found" }), {
        status: 404,
      }),
    );
    const adapter = new AdapterModule({ fetchImpl });

    await expect(
      adapter.invoke(
        "missing",
        {},
        {
          serviceMetadata: {
            url: "http://127.0.0.1:9999",
          },
          toolMetadata: {},
        },
      ),
    ).rejects.toThrow("tool not found");
  });

  it("invoke() throws when service metadata does not include URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = new AdapterModule({ fetchImpl });

    await expect(
      adapter.invoke(
        "tool-1",
        { input: "anything" },
        {
          serviceMetadata: {},
          toolMetadata: {},
        },
      ),
    ).rejects.toThrow("Service manifest metadata must include an adapter URL");
  });
});

describe("parseServiceManifest", () => {
  it("parses a JSON manifest string", () => {
    const parsed = parseServiceManifest(`
      {
        "name": "svc-echo",
        "description": "",
        "metadata": {
          "serverUrl": "http://127.0.0.1:8787"
        },
        "tools": [
          {
            "name": "echo",
            "description": "",
            "metadata": {
              "route": "invoke/echo"
            },
            "inputSchema": {
              "type": "object",
              "properties": {
                "input": { "type": "string" }
              }
            },
            "outputSchema": {
              "type": "string"
            }
          }
        ]
      }
    `);

    expect(parsed).toEqual({
      name: "svc-echo",
      description: "",
      metadata: {
        serverUrl: "http://127.0.0.1:8787",
      },
      tools: [
        {
          name: "echo",
          description: "",
          metadata: {
            route: "invoke/echo",
          },
          inputSchema: {
            type: "object",
            properties: {
              input: { type: "string" },
            },
          },
          outputSchema: {
            type: "string",
          },
        },
      ],
    });
  });

  it("rejects invalid JSON", () => {
    expect(() => parseServiceManifest("{ missing quote }")).toThrow(
      "Manifest JSON is invalid.",
    );
  });

  it("rejects malformed manifest shape", () => {
    expect(() =>
      parseServiceManifest(
        JSON.stringify({
          name: "svc-echo",
          metadata: {},
          tools: [
            {
              name: "echo",
            },
          ],
        }),
      ),
    ).toThrow("Manifest JSON is not a valid service manifest.");
  });
});
