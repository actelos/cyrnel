import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sirv from "sirv";

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || "0.0.0.0";

const dirname = fileURLToPath(new URL(".", import.meta.url));
const clientDir = join(dirname, "..");
const indexPath = join(clientDir, "index.html");

const CYRNEL_API_URL = process.env.CYRNEL_API_URL ?? "http://127.0.0.1:7687";
const CYRNEL_API_KEY = process.env.CYRNEL_API_KEY ?? "";

const configScript = `<script>window.__CYRNEL_CONFIG__=${JSON.stringify({ CYRNEL_API_URL, CYRNEL_API_KEY })}</script>`;

const raw = readFileSync(indexPath, "utf-8");
const clean = raw.replace(
  /<script>window\.__CYRNEL_CONFIG__=.*?<\/script>/g,
  "",
);
const injected = clean.replace("</head>", `${configScript}</head>`);
writeFileSync(indexPath, injected);

const serve = sirv(clientDir, { single: true, etag: true });

createServer(serve).listen(PORT, HOST, () => {
  console.log(`Cyrnel dashboard server listening on http://${HOST}:${PORT}`);
});
