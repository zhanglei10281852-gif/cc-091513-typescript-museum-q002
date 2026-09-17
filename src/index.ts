import { createApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";
// 运行时数据写入 .runtime/（README 约定，已在 .gitignore / .dockerignore 中）。
const dataFile = process.env.DATA_FILE ?? ".runtime/ledger.json";

createApp({ dataFile }).listen(port, host, () => {
  process.stdout.write(`service listening on ${host}:${port}\n`);
});
