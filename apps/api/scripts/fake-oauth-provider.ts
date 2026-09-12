import http from "node:http";
import url from "node:url";

const PORT = 9380;
const codes = new Map();

function html(page: string) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Fake OAuth</title>
<style>body{font-family:system-ui;max-width:600px;margin:2rem auto;padding:0 1rem}
.card{border:1px solid #ddd;padding:1.5rem;border-radius:8px}
button{background:#2563eb;color:#fff;border:none;padding:.6rem 1.2rem;border-radius:4px;cursor:pointer;font-size:1rem}
button:hover{background:#1d4ed8}</style></head><body>${page}</body></html>`;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url ?? "/", true);

  if (parsed.pathname === "/authorize" && req.method === "GET") {
    const {
      client_id,
      redirect_uri,
      scope,
      state,
      code_challenge,
      code_challenge_method,
    } = parsed.query;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      html(`
      <div class="card">
        <h2>Fake OAuth Provider</h2>
        <p><strong>Client:</strong> ${client_id}</p>
        <p><strong>Scope:</strong> ${scope}</p>
        <p><strong>Redirect:</strong> ${redirect_uri}</p>
        <p><strong>PKCE:</strong> ${code_challenge_method} (${code_challenge})</p>
        <form method="POST" action="/authorize">
          <input type="hidden" name="client_id" value="${client_id}">
          <input type="hidden" name="redirect_uri" value="${redirect_uri}">
          <input type="hidden" name="state" value="${state}">
          <input type="hidden" name="scope" value="${scope}">
          <button type="submit">Authorize</button>
        </form>
      </div>
    `),
    );
    return;
  }

  if (parsed.pathname === "/authorize" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const redirect_uri = params.get("redirect_uri")!;
      const state = params.get("state")!;
      const scope = params.get("scope")!;
      const code = `fake_code_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      codes.set(code, { scope, createdAt: Date.now() });
      const sep = redirect_uri.includes("?") ? "&" : "?";
      const location = `${redirect_uri}${sep}code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      console.log(`[oauth] Issued code=${code} for scope="${scope}"`);
      res.writeHead(302, { Location: location });
      res.end();
    });
    return;
  }

  if (parsed.pathname === "/token" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const code = params.get("code");
      const grant_type = params.get("grant_type");
      console.log(
        `[token] Exchange request: code=${code} grant_type=${grant_type}`,
      );
      if (!code || !codes.has(code)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        codes.delete(code!);
        return;
      }
      codes.delete(code);
      const token = `fake_token_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: token,
          token_type: "Bearer",
          expires_in: 3600,
          scope: params.get("scope") || "read write",
        }),
      );
      console.log(`[token] Issued access_token=${token.slice(0, 20)}...`);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Fake OAuth provider listening on http://127.0.0.1:${PORT}`);
  console.log(`  Authorization: http://127.0.0.1:${PORT}/authorize`);
  console.log(`  Token:         http://127.0.0.1:${PORT}/token`);
});
