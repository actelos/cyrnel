import http from "node:http";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const host = process.env.HOST ?? "127.0.0.1";
const toolPort = Number.parseInt(process.env.TOOL_PORT ?? "9999", 10);
const toolHost = process.env.TOOL_HOST ?? host;

const toolBaseUrl = `http://${toolHost}:${toolPort}`;

const quotes = [
  "Simplicity is the soul of efficiency. — Austin Freeman",
  "Make it work, make it right, make it fast. — Kent Beck",
  "Programs must be written for people to read. — Harold Abelson",
  "The only way to learn a new programming language is by writing programs in it. — Dennis Ritchie",
  "Premature optimization is the root of all evil. — Donald Knuth",
  "Debugging is like being the detective in a crime movie where you are also the murderer. — Filipe Fortes",
  "Code is like humor. When you have to explain it, it’s bad. — Cory House",
  "Small steps, continuous progress.",
  "Clarity beats cleverness.",
  "Ship the smallest useful thing.",
];

const manifest = {
  name: "svc_dummy",
  description: "Dummy service for local testing",
  enabled: true,
  metadata: {
    serverUrl: toolBaseUrl,
  },
  tools: [
    {
      name: "echo",
      description: "Echo the input string",
      enabled: true,
      metadata: {
        route: "invoke/echo",
      },
      inputSchema: {
        type: "object",
        properties: {
          input: { type: "string" },
        },
        required: ["input"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "string",
      },
    },
    {
      name: "calculator",
      description: "Perform a basic calculation on two numbers",
      enabled: true,
      metadata: {
        route: "invoke/calc",
      },
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
          operation: {
            type: "string",
            enum: ["add", "subtract", "multiply", "divide", "pow", "mod"],
          },
        },
        required: ["a", "b", "operation"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          result: { type: "number" },
        },
        required: ["result"],
        additionalProperties: false,
      },
    },
    {
      name: "random_quote",
      description: "Return a random quote from a local list",
      enabled: true,
      metadata: {
        route: "invoke/quote",
      },
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          quote: { type: "string" },
        },
        required: ["quote"],
        additionalProperties: false,
      },
    },
    {
      name: "random_number",
      description: "Generate a random integer in a range",
      enabled: true,
      metadata: {
        route: "invoke/random",
      },
      inputSchema: {
        type: "object",
        properties: {
          min: { type: "integer" },
          max: { type: "integer" },
        },
        required: ["min", "max"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          value: { type: "integer" },
        },
        required: ["value"],
        additionalProperties: false,
      },
    },
    {
      name: "time_now",
      description: "Return current server time in ISO format",
      enabled: true,
      metadata: {
        route: "invoke/time",
      },
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          iso: { type: "string" },
        },
        required: ["iso"],
        additionalProperties: false,
      },
    },
  ],
};

const definitionJson = JSON.stringify(manifest);

const registryPayload = (baseUrl) =>
  JSON.stringify({
    type: "custom",
    source: `${baseUrl}/definition.json`,
  });

let servedDefinition = false;

const server = http.createServer((req, res) => {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }

  const hostHeader = req.headers.host ?? `${host}:${port}`;
  const baseUrl = `http://${hostHeader}`;
  const path = req.url?.split("?")[0] ?? "/";

  if (path === "/" || path === "/registry.json") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(registryPayload(baseUrl));
    return;
  }

  if (path === "/definition.json") {
    if (servedDefinition) {
      res.statusCode = 410;
      res.end("Server already served the definition once.");
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(definitionJson);
    servedDefinition = true;
    return;
  }

  res.statusCode = 404;
  res.end("Not Found");
});

const toolServer = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }

  const path = req.url?.split("?")[0] ?? "/";
  const route = decodeURIComponent(path.replace(/^\//, ""));

  const validRoutes = new Set([
    "invoke/echo",
    "invoke/calc",
    "invoke/quote",
    "invoke/random",
    "invoke/time",
  ]);

  if (!validRoutes.has(route)) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }

  let bodyRaw = "";
  req.setEncoding("utf8");
  for await (const chunk of req) {
    bodyRaw += chunk;
  }

  let body;
  try {
    body = bodyRaw ? JSON.parse(bodyRaw) : {};
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ message: "Invalid JSON body." }));
    return;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (route === "invoke/echo") {
    if (!body || typeof body.input !== "string") {
      res.statusCode = 400;
      res.end(JSON.stringify({ message: "Field 'input' must be a string." }));
      return;
    }

    res.statusCode = 200;
    res.end(JSON.stringify({ output: body.input }));
    return;
  }

  if (route === "invoke/calc") {
    const { a, b, operation } = body ?? {};
    if (
      typeof a !== "number" ||
      typeof b !== "number" ||
      typeof operation !== "string"
    ) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          message:
            "Fields 'a' and 'b' must be numbers and 'operation' must be a string.",
        }),
      );
      return;
    }

    let result;
    switch (operation) {
      case "add":
        result = a + b;
        break;
      case "subtract":
        result = a - b;
        break;
      case "multiply":
        result = a * b;
        break;
      case "divide":
        if (b === 0) {
          res.statusCode = 400;
          res.end(
            JSON.stringify({ message: "Division by zero is not allowed." }),
          );
          return;
        }
        result = a / b;
        break;
      case "pow":
        result = a ** b;
        break;
      case "mod":
        if (b === 0) {
          res.statusCode = 400;
          res.end(
            JSON.stringify({ message: "Modulo by zero is not allowed." }),
          );
          return;
        }
        result = a % b;
        break;
      default:
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            message:
              "Invalid operation. Use add|subtract|multiply|divide|pow|mod.",
          }),
        );
        return;
    }

    res.statusCode = 200;
    res.end(JSON.stringify({ result }));
    return;
  }

  if (route === "invoke/quote") {
    const quote = quotes[Math.floor(Math.random() * quotes.length)];
    res.statusCode = 200;
    res.end(JSON.stringify({ quote }));
    return;
  }

  if (route === "invoke/random") {
    const { min, max } = body ?? {};
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({ message: "Fields 'min' and 'max' must be integers." }),
      );
      return;
    }

    if (min > max) {
      res.statusCode = 400;
      res.end(JSON.stringify({ message: "Field 'min' must be <= 'max'." }));
      return;
    }

    const value = Math.floor(Math.random() * (max - min + 1)) + min;
    res.statusCode = 200;
    res.end(JSON.stringify({ value }));
    return;
  }

  if (route === "invoke/time") {
    res.statusCode = 200;
    res.end(JSON.stringify({ iso: new Date().toISOString() }));
  }
});

server.listen(port, host, () => {
  console.log(`Definition server listening on http://${host}:${port}`);
});

toolServer.listen(toolPort, toolHost, () => {
  console.log(`Tool server listening on ${toolBaseUrl}`);
});
