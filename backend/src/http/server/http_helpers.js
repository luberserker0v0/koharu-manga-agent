const SSE_HEARTBEAT_INTERVAL_MS = 2000;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

function conflict(res, message) {
  sendJson(res, 409, { error: message });
}

function badRequest(res, message) {
  sendJson(res, 400, { error: message });
}

function writeSseEvent(res, eventType, payload) {
  res.write(`event: ${eventType}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeJobStreamEvent(res, eventType, payload, useMessageEnvelope) {
  writeSseEvent(res, useMessageEnvelope ? "message" : eventType, payload);
}

function beginSseHeartbeat(res) {
  const intervalId = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, SSE_HEARTBEAT_INTERVAL_MS);

  return () => clearInterval(intervalId);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    const limit = Number(req.maxJsonBodyBytes || 1048576);
    req.on("data", (chunk) => {
      if (settled) return;
      body += chunk;
      if (Buffer.byteLength(body) > limit) {
        settled = true;
        const error = new Error(`JSON request body exceeds the ${limit} byte limit.`);
        error.statusCode = 413;
        reject(error);
      }
    });
    req.on("end", () => {
      if (settled) return;
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

module.exports = {
  SSE_HEARTBEAT_INTERVAL_MS,
  badRequest,
  beginSseHeartbeat,
  conflict,
  notFound,
  readJsonBody,
  sendJson,
  writeJobStreamEvent,
  writeSseEvent,
};
