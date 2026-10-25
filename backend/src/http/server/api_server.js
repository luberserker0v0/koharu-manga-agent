const { createApiServer: createApiServerImpl } = require("./api_routes");
const { SSE_HEARTBEAT_INTERVAL_MS } = require("./http_helpers");

function createApiServer(options) {
  return createApiServerImpl(options);
}

module.exports = {
  createApiServer,
  SSE_HEARTBEAT_INTERVAL_MS,
};
