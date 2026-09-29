import { createHttpServer } from "./http.js";
import { loadConfig } from "./config.js";
import { ReviewService } from "./service.js";

const config = loadConfig({
  demo: process.argv.includes("--demo") || undefined,
});
const service = await ReviewService.create(config);
const server = createHttpServer(service, config);

const shutdown = async () => {
  server.closeAllConnections();
  server.close();
  await service.close();
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
server.listen(config.port, config.host, () => {
  process.stdout.write(
    `pr-review listening on http://${config.host}:${config.port}${config.demo ? " (DEMO MODE)" : ""}\n`,
  );
});
