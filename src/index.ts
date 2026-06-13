/**
 * Pangle coordinator entrypoint. Wires the backbone + leaf modules and starts the HTTP server.
 * The single integration point — owned by the integrator, not the per-module agents.
 */
import { config } from "./config.js";
import { makeLogger } from "./telemetry.js";
import { Db } from "./db.js";
import { createChain } from "./chain.js";
import { Auth } from "./auth.js";
import { Intelligence } from "./intelligence.js";
import { Scoring } from "./scoring.js";
import { makeApp } from "./coordinator.js";

const log = makeLogger("index");

const db = new Db(config.dbPath);
const chain = createChain(config);
const auth = new Auth(db, config);
const intel = new Intelligence(db, config);
const scoring = new Scoring(db, chain, config);

const app = makeApp({ db, chain, auth, intel, scoring, cfg: config, log });

const server = app.listen(config.port, "127.0.0.1", () => {
  log.info("coordinator up", {
    port: config.port,
    chainMode: chain.mode,
    coordinator: chain.coordinatorAddress,
    synthesisWindowHours: config.synthesisWindowHours,
  });
});

function shutdown(sig: string): void {
  log.warn("shutting down", { sig });
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // hard-exit fallback if close hangs
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
