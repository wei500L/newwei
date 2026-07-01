const { createHash } = require("node:crypto");
const { createServer } = require("node:http");

const PORT = Number(process.env.PORT || 3014);
const HOST = process.env.HOST || "0.0.0.0";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const sockets = new Set();

const json = (res, statusCode, payload) => {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
};

const server = createServer((req, res) => {
  if (req.method !== "GET") {
    json(res, 405, { error: "Method Not Allowed" });
    return;
  }

  if (req.url === "/healthz") {
    json(res, 200, {
      status: "ok",
      clients: sockets.size,
    });
    return;
  }

  if (req.url === "/health") {
    json(res, 200, {
      status: "ok",
      clients: sockets.size,
      mode: "hold-open-no-messages",
    });
    return;
  }

  json(res, 404, { error: "Not Found" });
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const upgrade = req.headers.upgrade;
  if (typeof key !== "string" || upgrade?.toLowerCase() !== "websocket") {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const accept = createHash("sha1")
    .update(`${key}${WS_GUID}`, "utf8")
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"),
  );

  sockets.add(socket);
  socket.setKeepAlive(true, 1000);

  socket.on("data", () => {
    // Intentionally discard frames: the relay should see an established
    // upstream with zero payloads, which drives the startup smoke condition.
  });
  socket.on("close", () => {
    sockets.delete(socket);
  });
  socket.on("end", () => {
    sockets.delete(socket);
  });
  socket.on("error", () => {
    sockets.delete(socket);
  });
});

const shutdown = (signal) => {
  process.stdout.write(`[mock-ais-upstream] ${signal} received; shutting down\n`);
  for (const socket of sockets) {
    socket.destroy();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref?.();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `[mock-ais-upstream] listening on http://${HOST}:${PORT}\n`,
  );
});
