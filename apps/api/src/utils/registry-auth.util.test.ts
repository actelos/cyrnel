import { createServer, type Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  exchangeClientCredentials,
  isCredentialTransportAllowed,
} from "@/utils/registry-auth.util";

const { lookupMock } = vi.hoisted(() => {
  const lookupMock = vi.fn(async (host: string) => {
    switch (host) {
      case "loopback.fixture":
        return [{ address: "127.0.0.1", family: 4 }];
      case "intranet.fixture":
        return [{ address: "10.20.30.40", family: 4 }];
      case "public.fixture":
        return [{ address: "192.0.2.9", family: 4 }];
      case "multi.fixture":
        return [
          { address: "10.20.30.40", family: 4 },
          { address: "192.0.2.9", family: 4 },
        ];
      case "unresolvable.fixture":
        throw new Error("ENOTFOUND");
      default:
        throw new Error("ENOTFOUND");
    }
  });
  return { lookupMock };
});

vi.mock("node:dns/promises", () => ({ default: { lookup: lookupMock } }));

const originalInsecureCIDRs = process.env.CYRNEL_REGISTRY_AUTH_INSECURE_CIDRS;

describe("isCredentialTransportAllowed", () => {
  beforeEach(() => {
    delete process.env.CYRNEL_REGISTRY_AUTH_INSECURE_CIDRS;
  });

  afterEach(() => {
    if (originalInsecureCIDRs === undefined) {
      delete process.env.CYRNEL_REGISTRY_AUTH_INSECURE_CIDRS;
    } else {
      process.env.CYRNEL_REGISTRY_AUTH_INSECURE_CIDRS = originalInsecureCIDRs;
    }
  });

  it("always allows https", async () => {
    await expect(
      isCredentialTransportAllowed("https://public.fixture/definitions/v1"),
    ).resolves.toBe(true);
  });

  it("allows http when the hostname resolves to loopback", async () => {
    await expect(
      isCredentialTransportAllowed("http://loopback.fixture/definitions/v1"),
    ).resolves.toBe(true);
  });

  it("rejects http for a public-resolving hostname", async () => {
    await expect(
      isCredentialTransportAllowed("http://public.fixture/definitions/v1"),
    ).resolves.toBe(false);
  });

  it("rejects http for an intranet-resolving hostname without a CIDR opt-in", async () => {
    await expect(
      isCredentialTransportAllowed("http://intranet.fixture/definitions/v1"),
    ).resolves.toBe(false);
  });

  it("allows http when the resolved address matches CYRNEL_REGISTRY_AUTH_INSECURE_CIDRS", async () => {
    process.env.CYRNEL_REGISTRY_AUTH_INSECURE_CIDRS = "10.0.0.0/8";
    await expect(
      isCredentialTransportAllowed("http://intranet.fixture/definitions/v1"),
    ).resolves.toBe(true);
  });

  it("allows http when any resolved address matches the CIDR opt-in", async () => {
    process.env.CYRNEL_REGISTRY_AUTH_INSECURE_CIDRS = "10.0.0.0/8";
    await expect(
      isCredentialTransportAllowed("http://multi.fixture/definitions/v1"),
    ).resolves.toBe(true);
  });

  it("allows http when the CIDR opt-in matches a different resolved address", async () => {
    process.env.CYRNEL_REGISTRY_AUTH_INSECURE_CIDRS = "192.0.2.0/24";
    await expect(
      isCredentialTransportAllowed("http://multi.fixture/definitions/v1"),
    ).resolves.toBe(true);
  });

  it("rejects http for an unresolvable hostname", async () => {
    await expect(
      isCredentialTransportAllowed(
        "http://unresolvable.fixture/definitions/v1",
      ),
    ).resolves.toBe(false);
  });

  it("rejects non-http(s) URLs outright", async () => {
    await expect(
      isCredentialTransportAllowed("ftp://public.fixture/x"),
    ).resolves.toBe(false);
    await expect(isCredentialTransportAllowed("not-a-url")).resolves.toBe(
      false,
    );
  });
});

describe("exchangeClientCredentials", () => {
  let server: Server;
  let baseUrl: string;
  let requestBodies: string[];
  let exchangeCount: number;

  const originalAllowedIPs = process.env.CYRNEL_REGISTRY_ALLOWED_IPS;

  beforeEach(async () => {
    process.env.CYRNEL_REGISTRY_ALLOWED_IPS = "127.0.0.1/32";
    requestBodies = [];
    exchangeCount = 0;
    server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/oauth/token") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        exchangeCount += 1;
        requestBodies.push(body);
        const params = new URLSearchParams(body);
        if (
          params.get("client_id") !== "valid-client" ||
          params.get("client_secret") !== "valid-secret"
        ) {
          res
            .writeHead(401, { "content-type": "application/json" })
            .end(JSON.stringify({ error: "invalid_client" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "issued-token",
            token_type: "Bearer",
            expires_in: 60,
            refresh_token: "issued-refresh",
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("fixture server did not bind a port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (originalAllowedIPs === undefined) {
      delete process.env.CYRNEL_REGISTRY_ALLOWED_IPS;
    } else {
      process.env.CYRNEL_REGISTRY_ALLOWED_IPS = originalAllowedIPs;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("exchanges client credentials and returns the token state", async () => {
    const state = await exchangeClientCredentials({
      type: "oauth2",
      clientId: "valid-client",
      clientSecret: "valid-secret",
      tokenEndpoint: `${baseUrl}/oauth/token`,
    });

    expect(state.accessToken).toBe("issued-token");
    expect(state.refreshToken).toBe("issued-refresh");
    expect(state.expiresAt).toBeGreaterThan(Date.now() + 45_000);
    expect(state.expiresAt).toBeLessThanOrEqual(Date.now() + 61_000);

    const params = new URLSearchParams(requestBodies[0]);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("valid-client");
    expect(params.get("client_secret")).toBe("valid-secret");
    expect(params.get("scope")).toBeNull();
  });

  it("sends the requested scopes space-joined", async () => {
    await exchangeClientCredentials({
      type: "oauth2",
      clientId: "valid-client",
      clientSecret: "valid-secret",
      tokenEndpoint: `${baseUrl}/oauth/token`,
      scopes: ["definitions:read", "modules:read"],
    });

    const params = new URLSearchParams(requestBodies[0]);
    expect(params.get("scope")).toBe("definitions:read modules:read");
  });

  it("throws a 502 when the endpoint response is not ok", async () => {
    await expect(
      exchangeClientCredentials({
        type: "oauth2",
        clientId: "wrong-client",
        clientSecret: "valid-secret",
        tokenEndpoint: `${baseUrl}/oauth/token`,
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining("status 401"),
    });
  });

  it("throws a 502 when the response is not JSON", async () => {
    const rawServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not json");
    });
    await new Promise<void>((resolve) => {
      rawServer.listen(0, "127.0.0.1", resolve);
    });
    const address = rawServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("raw fixture server did not bind a port");
    }
    try {
      await expect(
        exchangeClientCredentials({
          type: "oauth2",
          clientId: "valid-client",
          clientSecret: "valid-secret",
          tokenEndpoint: `http://127.0.0.1:${address.port}/oauth/token`,
        }),
      ).rejects.toMatchObject({
        statusCode: 502,
        message: expect.stringContaining("invalid JSON"),
      });
    } finally {
      await new Promise<void>((resolve) => {
        rawServer.close(() => resolve());
      });
    }
  });

  it("throws a 502 when the access token is missing", async () => {
    const rawServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token_type: "Bearer" }));
    });
    await new Promise<void>((resolve) => {
      rawServer.listen(0, "127.0.0.1", resolve);
    });
    const address = rawServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("raw fixture server did not bind a port");
    }
    try {
      await expect(
        exchangeClientCredentials({
          type: "oauth2",
          clientId: "valid-client",
          clientSecret: "valid-secret",
          tokenEndpoint: `http://127.0.0.1:${address.port}/oauth/token`,
        }),
      ).rejects.toMatchObject({
        statusCode: 502,
        message: expect.stringContaining("missing an access token"),
      });
    } finally {
      await new Promise<void>((resolve) => {
        rawServer.close(() => resolve());
      });
    }
  });

  it("throws a 400 when the token endpoint transport refuses credentials", async () => {
    await expect(
      exchangeClientCredentials({
        type: "oauth2",
        clientId: "valid-client",
        clientSecret: "valid-secret",
        tokenEndpoint: "http://public.fixture/oauth/token",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("must be https"),
    });
  });

  it("throws a 502 when the token endpoint is unreachable", async () => {
    const deadServer = createServer(() => {});
    await new Promise<void>((resolve) => {
      deadServer.listen(0, "127.0.0.1", resolve);
    });
    const address = deadServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("dead fixture server did not bind a port");
    }
    await new Promise<void>((resolve) => {
      deadServer.close(() => resolve());
    });

    await expect(
      exchangeClientCredentials({
        type: "oauth2",
        clientId: "valid-client",
        clientSecret: "valid-secret",
        tokenEndpoint: `http://127.0.0.1:${address.port}/oauth/token`,
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining("unreachable"),
    });
    expect(exchangeCount).toBe(0);
  });

  it("coerces expires_in into an epoch-millisecond expiry", async () => {
    const serverPort = baseUrl.split(":").pop();
    void serverPort;
    const noExpiryServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "tok" }));
    });
    await new Promise<void>((resolve) => {
      noExpiryServer.listen(0, "127.0.0.1", resolve);
    });
    const address = noExpiryServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("no-expiry fixture server did not bind a port");
    }
    try {
      const state = await exchangeClientCredentials({
        type: "oauth2",
        clientId: "valid-client",
        clientSecret: "valid-secret",
        tokenEndpoint: `http://127.0.0.1:${address.port}/oauth/token`,
      });
      expect(state.expiresAt).toBeGreaterThan(Date.now() + 3_590_000);
      expect(state.expiresAt).toBeLessThanOrEqual(Date.now() + 3_601_000);
    } finally {
      await new Promise<void>((resolve) => {
        noExpiryServer.close(() => resolve());
      });
    }
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });
});
