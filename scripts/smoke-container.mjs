// Local runtime-image qualification, without host configuration or provider keys.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const image = process.argv[2];
if (!image || image.startsWith("-") || !/^[a-zA-Z0-9_./:@-]+$/.test(image)) throw new Error("Pass the exact local image reference");
const name = "wyvern-smoke-" + randomUUID();
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
let started = false;
try {
  docker("run", "--detach", "--rm", "--name", name, "--read-only", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--pids-limit", "64", "--memory", "128m",
    "--tmpfs", "/run/wyvern:rw,nosuid,nodev,noexec,size=1m,uid=10001,gid=10001,mode=0750",
    "--tmpfs", "/run/wyvern-admin:rw,nosuid,nodev,noexec,size=1m,uid=10001,gid=10001,mode=0750",
    "--tmpfs", "/var/lib/wyvern:rw,nosuid,nodev,noexec,size=2m,uid=10001,gid=10001,mode=0700", image);
  started = true;
  let status;
  for (let attempt = 0; attempt < 25; attempt++) {
    try { status = JSON.parse(docker("exec", name, "node", "/app/bin/wyvern.js", "status", "--json")); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(status?.service, "wyvern"); assert.equal(status.state, "unconfigured"); assert.equal(status.ready, false);
  assert.equal(docker("exec", name, "node", "-e", "process.stdout.write(String(process.getuid()))"), "10001");
  const script = "import {localRequest} from '/app/src/local-client.js'; const live=await localRequest('/run/wyvern/client.sock','GET','/health/live'); if(!live.alive)throw Error('not-live'); try{await localRequest('/run/wyvern/client.sock','POST','/v1/drain',{enabled:true});throw Error('admin-exposed')}catch(e){if(e.message==='admin-exposed')throw e} const status=await localRequest('/run/wyvern-admin/admin.sock','POST','/v1/drain',{enabled:true}); if(!status.drain)throw Error('drain-not-applied');";
  docker("exec", name, "node", "--input-type=module", "-e", script);
  const inspection = JSON.parse(docker("inspect", "--format", "{{json .HostConfig}}", name));
  assert.equal(inspection.ReadonlyRootfs, true); assert.equal(inspection.Privileged, false); assert.equal(inspection.NetworkMode, "none");
  process.stdout.write(JSON.stringify({ schema: "exocortex.wyvern.container-evidence.v1", result: "PASS", image,
    non_root: true, read_only_root: true, no_network: true, cold_unconfigured: true, separated_admin_socket: true }) + "\n");
} finally { if (started) docker("stop", "--time", "5", name); }
