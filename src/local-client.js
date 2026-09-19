import http from "node:http";
import { fault } from "./errors.js";
import { readBody } from "./util.js";

export function localRequest(socketPath, method, route, body, { token, timeout = 10000 } = {}) {
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method, path: route, headers: {
      Host: "wyvern.local", ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(bytes ? { "Content-Type": "application/json", "Content-Length": bytes.length } : {}),
    }, signal: AbortSignal.timeout(timeout) }, async response => {
      try {
        const data = JSON.parse((await readBody(response, 4194304)).toString("utf8"));
        if (response.statusCode >= 400) fault(data.error?.code ?? "wyvern_unavailable", response.statusCode);
        resolve(data);
      } catch (error) { reject(error); }
    });
    request.on("error", () => reject(new Error("wyvern_unavailable")));
    request.end(bytes);
  });
}
