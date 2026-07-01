import http, { createServer } from "node:http";
import https from "node:https";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sirv from "sirv";

const PORT = Number(process.env.PORT) || 9372;
const HOST = process.env.HOST || "0.0.0.0";
const isDev = process.env.NODE_ENV === "development";

const dirname = fileURLToPath(new URL(".", import.meta.url));
const clientDir = join(dirname, "..");

const CYRNEL_API_URL = process.env.CYRNEL_API_URL || "http://127.0.0.1:9371";
const CYRNEL_API_KEY = process.env.CYRNEL_API_KEY ?? "";

const apiUrl = new URL(CYRNEL_API_URL);

const API_PATHS = [
  "/health",
  "/modules",
  "/services",
  "/tools",
  "/processes",
  "/environment",
];

function isApiPath(pathname: string): boolean {
  return API_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

const serve = sirv(clientDir, { single: true, etag: true });

const server = createServer((req, res) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );

  if (isApiPath(url.pathname)) {
    const isSpaNavigation = req.headers.accept?.includes("text/html") ?? false;

    if (!isSpaNavigation) {
      const proxyModule = apiUrl.protocol === "https:" ? https : http;

      const hopByHop = new Set([
        "connection",
        "keep-alive",
        "transfer-encoding",
        "upgrade",
        "proxy-authorization",
        "proxy-authenticate",
        "te",
        "trailer",
      ]);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (!hopByHop.has(key) && typeof value === "string") {
          headers[key] = value;
        }
      }
      headers.host = apiUrl.host;

      if (CYRNEL_API_KEY) {
        headers.authorization = `Bearer ${CYRNEL_API_KEY}`;
      }

      const proxyReq = proxyModule.request(
        {
          hostname: apiUrl.hostname,
          port: apiUrl.port,
          path: req.url,
          method: req.method,
          headers,
          rejectUnauthorized: !isDev,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );

      proxyReq.on("error", () => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad gateway" }));
      });

      req.pipe(proxyReq);
      return;
    }
  }

  serve(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Cyrnel dashboard server listening on http://${HOST}:${PORT}`);
});
