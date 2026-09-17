import { createApp } from "./app.js";
import { JsonFileStore } from "./ledger/state.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const ledgerPath = process.env.LEDGER_PATH ?? ".runtime/ledger.json";

const store = new JsonFileStore(ledgerPath);
const state = await store.load();

const app = createApp({ store, state: state ?? undefined });

app.listen(port, host, () => {
  process.stdout.write(`service listening on ${host}:${port}\n`);
});
