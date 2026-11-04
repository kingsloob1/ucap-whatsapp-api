/**
 * Everything for local development, in one terminal:
 *
 * - the API under `bun --watch` (restarts on every server change);
 * - the UI dev server under `bun --hot` (chat at /, admin at /admin/, HMR);
 * - `bun-client watch`, which regenerates ui/src/api.gen.ts whenever the API's
 *   routes or schemas change, so the UIs' typed client follows the server live.
 *
 *   bun run dev:all
 */
const port = process.env.PORT ?? "3000";
const uiPort = process.env.UI_PORT ?? "3001";
const env = {
  ...process.env,
  PORT: port,
  UI_PORT: uiPort,
  API_URL: `http://127.0.0.1:${port}`,
};

const commands: [name: string, cmd: string[]][] = [
  ["api", ["bun", "--watch", "src/main.ts"]],
  ["ui", ["bun", "--hot", "ui/server.ts"]],
  [
    "types",
    [
      "bunx",
      "bun-client",
      "watch",
      "--out",
      "ui/src/api.gen.ts",
      "--url",
      `http://127.0.0.1:${port}`,
    ],
  ],
];

const colours: Record<string, string> = {
  api: "\x1b[36m",
  ui: "\x1b[35m",
  types: "\x1b[33m",
};

async function pipe(name: string, stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines)
      console.log(`${colours[name]}[${name}]\x1b[0m ${line}`);
  }
}

const children = commands.map(([name, cmd]) => {
  const child = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
  void pipe(name, child.stdout);
  void pipe(name, child.stderr);
  return { name, child };
});

function stop() {
  for (const { child } of children) child.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const first = await Promise.race(
  children.map(async ({ name, child }) => ({ name, code: await child.exited })),
);
console.log(`[${first.name}] exited with ${first.code}; stopping the rest`);
stop();
process.exit(first.code ?? 0);
