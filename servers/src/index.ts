import "dotenv/config";
import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { getEnv } from "./config/env.js";

const env = getEnv();

serve(
  {
    fetch: app.fetch,
    port: env.PORT,
    hostname: env.HOST,
  },
  (info) => {
    console.log(
      `[server] nolen-ai backend listening on http://${info.address}:${info.port}`,
    );
    console.log(`[server] execution mode: ${env.EXECUTION_MODE}`);
  },
);
