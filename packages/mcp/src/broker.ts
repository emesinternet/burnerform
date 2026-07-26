import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Burnerform, EnvironmentSecretProvider } from "@burnerform/sdk/node";
import { BurnerformToolHandlers } from "./tool-registry";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1_048_576;

interface BrokerOptions {
  baseUrl: string;
  dataDirectory: string;
  secretMode: "environment" | "keyring";
}

interface BrokerRequest {
  version: number;
  token: string;
  id: string;
  baseUrl: string;
  secretMode: BrokerOptions["secretMode"];
  name: string;
  input: unknown;
}

function brokerPaths(dataDirectory: string) {
  const hash = createHash("sha256")
    .update(path.resolve(dataDirectory))
    .digest("hex")
    .slice(0, 24);
  return {
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\burnerform-${hash}`
        : path.join(dataDirectory, `.broker-${hash}.sock`),
    token: path.join(dataDirectory, ".broker-token"),
    election: path.join(dataDirectory, ".broker-starting"),
  };
}

async function brokerToken(tokenPath: string) {
  try {
    return (await readFile(tokenPath, "utf8")).trim();
  } catch {
    const token = randomBytes(32).toString("base64url");
    try {
      await writeFile(tokenPath, token, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      if (process.platform !== "win32") await chmod(tokenPath, 0o600);
      return token;
    } catch {
      return (await readFile(tokenPath, "utf8")).trim();
    }
  }
}

function parseFrame(value: string): BrokerRequest {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object")
    throw new Error("Invalid broker request.");
  const request = parsed as Partial<BrokerRequest>;
  if (
    request.version !== PROTOCOL_VERSION ||
    typeof request.token !== "string" ||
    typeof request.id !== "string" ||
    typeof request.baseUrl !== "string" ||
    (request.secretMode !== "environment" &&
      request.secretMode !== "keyring") ||
    typeof request.name !== "string"
  )
    throw new Error("Invalid broker request.");
  return request as BrokerRequest;
}

function writeFrame(socket: net.Socket, value: unknown) {
  socket.end(`${JSON.stringify(value)}\n`);
}

function validToken(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export async function runBroker(options: BrokerOptions) {
  await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
  const paths = brokerPaths(options.dataDirectory);
  if (process.platform !== "win32") await rm(paths.endpoint, { force: true });
  const token = await brokerToken(paths.token);
  const burnerform = await Burnerform.open({
    baseUrl: options.baseUrl,
    dataDirectory: options.dataDirectory,
    secretProvider:
      options.secretMode === "environment"
        ? new EnvironmentSecretProvider()
        : undefined,
  });
  await burnerform.reconcile();
  const handlers = new BurnerformToolHandlers(burnerform);
  let queue = Promise.resolve();
  const server = net.createServer((socket) => {
    const controller = new AbortController();
    socket.once("close", () =>
      controller.abort(new Error("MCP client disconnected.")),
    );
    socket.setEncoding("utf8");
    let frame = "";
    socket.on("data", (chunk) => {
      frame += chunk;
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      const newline = frame.indexOf("\n");
      if (newline < 0) return;
      socket.pause();
      const execute = async () => {
        try {
          if (controller.signal.aborted)
            throw controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new Error("MCP client disconnected.");
          const request = parseFrame(frame.slice(0, newline));
          if (
            !validToken(request.token, token) ||
            request.baseUrl !== options.baseUrl ||
            request.secretMode !== options.secretMode
          )
            throw new Error(
              "The local Burnerform broker configuration does not match.",
            );
          if (request.name === "__broker_ping__") {
            writeFrame(socket, { id: request.id, result: { broker: true } });
            return;
          }
          if (request.name === "__broker_shutdown__") {
            writeFrame(socket, { id: request.id, result: { stopped: true } });
            setTimeout(() => void shutdown(), 25).unref();
            return;
          }
          const result = await handlers.call(
            request.name as Parameters<typeof handlers.call>[0],
            request.input,
            controller.signal,
          );
          writeFrame(socket, { id: request.id, result });
        } catch (error) {
          writeFrame(socket, {
            id: undefined,
            error: {
              name: error instanceof Error ? error.name : "Error",
              message:
                error instanceof Error
                  ? error.message
                  : "The broker request failed.",
            },
          });
        }
      };
      queue = queue.then(execute, execute);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.endpoint, resolve);
  });
  await rm(paths.election, { force: true });
  const shutdown = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await burnerform.close();
    if (process.platform !== "win32") await rm(paths.endpoint, { force: true });
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit()));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit()));
  return { close: shutdown };
}

async function callBroker(
  options: BrokerOptions,
  name: string,
  input: unknown,
  signal?: AbortSignal,
) {
  const paths = brokerPaths(options.dataDirectory);
  const token = await brokerToken(paths.token);
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.createConnection(paths.endpoint);
    let frame = "";
    const abort = () => {
      socket.destroy();
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Operation cancelled."),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      frame += chunk;
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
        socket.destroy();
        reject(new Error("The local broker response was too large."));
        return;
      }
      const newline = frame.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      signal?.removeEventListener("abort", abort);
      try {
        const response = JSON.parse(frame.slice(0, newline)) as {
          result?: Record<string, unknown>;
          error?: { name: string; message: string };
        };
        if (response.error) {
          const error = new Error(response.error.message);
          error.name = response.error.name;
          reject(error);
        } else if (response.result) resolve(response.result);
        else
          reject(new Error("The local broker returned an invalid response."));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          version: PROTOCOL_VERSION,
          token,
          id: randomUUID(),
          baseUrl: options.baseUrl,
          secretMode: options.secretMode,
          name,
          input,
        } satisfies BrokerRequest)}\n`,
      );
    });
  });
}

async function canConnect(options: BrokerOptions) {
  try {
    await callBroker(options, "__broker_ping__", {});
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        "The local Burnerform broker configuration does not match."
    )
      throw error;
    return false;
  }
  return true;
}

export async function ensureBroker(options: BrokerOptions) {
  if (await canConnect(options)) return;
  const paths = brokerPaths(options.dataDirectory);
  await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
  let elected = false;
  try {
    const handle = await open(paths.election, "wx", 0o600);
    await handle.writeFile(String(process.pid));
    await handle.close();
    elected = true;
  } catch {
    try {
      const age = Date.now() - (await stat(paths.election)).mtimeMs;
      if (age > 15_000) await rm(paths.election, { force: true });
    } catch {
      // Another client may remove or replace the election file first.
    }
  }
  if (elected) {
    const child = spawn(process.execPath, [process.argv[1], "--broker"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
      windowsHide: true,
    });
    child.unref();
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await canConnect(options)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "The local Burnerform broker could not start. Close older Burnerform MCP processes, then restart Codex.",
  );
}

export function createBrokerCaller(options: BrokerOptions) {
  return {
    call(name: string, input: unknown, signal?: AbortSignal) {
      return callBroker(options, name, input, signal);
    },
  };
}

export async function stopBroker(options: BrokerOptions) {
  try {
    await callBroker(options, "__broker_shutdown__", {});
  } catch {
    // Stopping an absent broker is already the requested state.
  }
}
