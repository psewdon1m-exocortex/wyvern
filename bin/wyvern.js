#!/usr/bin/env node
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Kernel } from "../src/kernel.js";
import { Runtime } from "../src/runtime.js";
import { createServer } from "../src/server.js";
import { localRequest } from "../src/local-client.js";
import { validateConfig } from "../src/config.js";
import { fields, readBody } from "../src/util.js";
import { publicError } from "../src/errors.js";
import { Audit } from "../src/audit.js";

export async function listenLocal(runtime, clientSocket, adminSocket) {
  if (!path.isAbsolute(clientSocket) || !path.isAbsolute(adminSocket) || path.dirname(clientSocket) === path.dirname(adminSocket)) throw new Error("invalid_socket_boundary");
  const servers = [createServer(runtime), createServer(runtime, { admin: true })];
  const close = async () => {
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  };
  try {
    for (const [index, socket, mode] of [[0, clientSocket, 0o660], [1, adminSocket, 0o600]]) {
      await fs.mkdir(path.dirname(socket), { recursive: true, mode: 0o750 });
      // Only Updater repair may remove a positively stale socket.
      servers[index].listen(socket); await once(servers[index], "listening"); await fs.chmod(socket, mode);
    }
  } catch (error) { await close(); await runtime.stop(0); throw error; }
  return close;
}

export async function secretFile(filename) {
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 4096 || process.platform !== "win32" && (stat.mode & 0o007)) throw new Error("invalid_credential_file");
    const value = await handle.readFile("utf8");
    if (/[\r\n\0]/.test(value)) throw new Error("invalid_credential_file");
    return value;
  } finally { await handle.close(); }
}

async function serve() {
  const filename = process.env.WYVERN_BOOTSTRAP_FILE || "/etc/wyvern/bootstrap.json";
  let body;
  try { body = await fs.readFile(filename, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; body = "null"; }
  if (Buffer.byteLength(body) > 16384) throw new Error("invalid_bootstrap");
  const loaded = JSON.parse(body), bootstrap = loaded ?? {};
  if (loaded !== null) fields(bootstrap, ["kernel_origin", "kernel_credential_file", "config_key", "client_socket", "admin_socket"], ["kernel_origin", "kernel_credential_file"]);
  const clientSocket = bootstrap.client_socket || "/run/wyvern/client.sock";
  const adminSocket = bootstrap.admin_socket || "/run/wyvern-admin/admin.sock";
  if (!path.isAbsolute(clientSocket) || !path.isAbsolute(adminSocket) || path.dirname(clientSocket) === path.dirname(adminSocket)) throw new Error("invalid_socket_boundary");
  const token = () => secretFile(bootstrap.kernel_credential_file);
  const kernel = loaded === null ? { async snapshot() { throw new Error("bootstrap_required"); } }
    : new Kernel({ origin: bootstrap.kernel_origin, token, configKey: bootstrap.config_key });
  const sink = event => { if (process.stdout.writableLength < 65536) process.stdout.write(JSON.stringify(event) + "\n"); };
  const audit = new Audit(process.env.WYVERN_AUDIT_DIR || "/var/lib/wyvern/audit");
  const runtime = new Runtime({ kernel, sink, audit });
  await runtime.start();
  const close = await listenLocal(runtime, clientSocket, adminSocket);
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    await runtime.stop(30000);
    await close(); await audit.flush();
  };
  process.on("SIGTERM", () => { stop().catch(() => { process.exitCode = 1; }); });
  process.on("SIGINT", () => { stop().catch(() => { process.exitCode = 1; }); });
}
export async function main(args) {
  const json = args.includes("--json"); args = args.filter(item => item !== "--json");
  const [command, subcommand, ...remaining] = args;
  if (remaining.length || args.some(item => item.startsWith("--"))) throw new Error("invalid_arguments");
  let result;
  if (command === "version" && !subcommand) result = { schema: "exocortex.wyvern.version.v1", service: "wyvern", version: "0.0.1", api_version: 1 };
  else if (command === "serve" && !subcommand) return serve();
  else if (command === "config" && subcommand === "validate") {
    const input = await readBody(process.stdin, 262144);
    validateConfig(JSON.parse(input.toString("utf8")));
    result = { valid: true, schema: "exocortex.wyvern.validation.v1" };
  } else {
    const socket = process.env.WYVERN_ADMIN_SOCKET || "/run/wyvern-admin/admin.sock";
    if (["status", "doctor", "health", "preflight", "adapters"].includes(command) && !subcommand) {
      result = await localRequest(socket, "GET", command === "preflight" ? "/v1/preflight" : command === "adapters" ? "/v1/catalog" : "/v1/status");
      if (["health", "preflight"].includes(command) && !result.ready) process.exitCode = 1;
    } else if (command === "reload" && !subcommand) result = await localRequest(socket, "POST", "/v1/reload");
    else if (command === "drain" && ["on", "off"].includes(subcommand)) result = await localRequest(socket, "POST", "/v1/drain", { enabled: subcommand === "on" });
    else throw new Error("usage: wyvern version|serve|status|doctor|health|preflight|reload|drain on|drain off|config validate [--json]");
  }
  process.stdout.write(JSON.stringify(result, null, json ? undefined : 2) + "\n");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    const known = publicError(error, null);
    const code = known.body.error.code === "internal_error" ? "operation_failed" : known.body.error.code;
    process.stderr.write(code + "\n"); process.exitCode = 1;
  });
}
