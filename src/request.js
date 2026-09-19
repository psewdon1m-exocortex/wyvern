import Ajv from "ajv";
import { fault } from "./errors.js";
import { fields, object, integer, ID } from "./util.js";

// Bounded structural JSON Schema subset. Regex, remote references and recursion
// are intentionally unsupported; no network or executable schema vocabulary.
const schemaKeys = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "oneOf", "allOf", "$defs", "$ref", "definitions", "title", "description", "default", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems"]);
export function compileSchema(schema) {
  if (Buffer.byteLength(JSON.stringify(schema)) > 32768) fault("invalid_schema");
  let nodes = 0;
  function walk(node, depth = 0, refs = new Set()) {
    if (++nodes > 1024 || depth > 16 || !object(node) || Object.keys(node).some(key => !schemaKeys.has(key))) fault("invalid_schema");
    if (node.$ref) {
      if (typeof node.$ref !== "string" || !/^#\/(?:\$defs|definitions)\/[A-Za-z0-9_-]+$/.test(node.$ref) || refs.has(node.$ref)) fault("invalid_schema");
      const [, group, name] = node.$ref.split("/");
      if (!object(schema[group]) || !Object.hasOwn(schema[group], name)) fault("invalid_schema");
      walk(schema[group][name], depth + 1, new Set([...refs, node.$ref]));
    }
    for (const key of ["properties", "$defs", "definitions"]) if (node[key] !== undefined) {
      if (!object(node[key])) fault("invalid_schema");
      for (const value of Object.values(node[key])) walk(value, depth + 1, refs);
    }
    for (const key of ["anyOf", "oneOf", "allOf"]) if (node[key] !== undefined) {
      if (!Array.isArray(node[key]) || node[key].length > 16) fault("invalid_schema");
      for (const value of node[key]) walk(value, depth + 1, refs);
    }
    if (node.items !== undefined) walk(node.items, depth + 1, refs);
    if (object(node.additionalProperties)) walk(node.additionalProperties, depth + 1, refs);
  }
  walk(schema);
  try { return new Ajv({ strict: false, allErrors: false, ownProperties: true, validateFormats: false }).compile(schema); }
  catch { fault("invalid_schema"); }
}

export function validateRequest(input, profile, { countOnly = false } = {}) {
  fields(input, ["adapter_id", "profile", "function", "messages", "options", "response_format", "stream", "metadata"], ["messages"]);
  if (input.adapter_id !== undefined && !ID.test(input.adapter_id) || input.profile !== undefined && !ID.test(input.profile) ||
      input.function !== undefined && !ID.test(input.function) || input.stream !== undefined && typeof input.stream !== "boolean") fault("invalid_request");
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 128) fault("invalid_request");
  let systemSeen = false;
  for (let index = 0; index < input.messages.length; index++) {
    const message = input.messages[index];
    fields(message, ["role", "content"], ["role", "content"]);
    if (!["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string" || !message.content.length) fault("invalid_request");
    if (message.role === "system") {
      if (index !== 0 || systemSeen) fault("invalid_request");
      systemSeen = true;
    }
  }
  if (!input.messages.some(item => item.role === "user")) fault("invalid_request");
  fields(input.options ?? {}, ["max_output_tokens", "temperature", "timeout_ms"]);
  const options = { max_output_tokens: profile.max_output_tokens, temperature: profile.temperature ?? 0.2, ...input.options };
  if (!integer(options.max_output_tokens, 1, profile.max_output_tokens) ||
      !(typeof options.temperature === "number" && options.temperature >= 0 && options.temperature <= 2) ||
      options.timeout_ms !== undefined && !integer(options.timeout_ms, 100, 300000)) fault("policy_violation", 422);
  if (input.metadata !== undefined && (!object(input.metadata) || Buffer.byteLength(JSON.stringify(input.metadata)) > 2048)) fault("invalid_request");
  let validate;
  if (input.response_format !== undefined) {
    fields(input.response_format, ["type", "schema"], ["type", "schema"]);
    if (input.response_format.type !== "json_schema") fault("invalid_request");
    if (!profile.capabilities.includes("structured_output")) fault("capability_not_supported", 422);
    validate = compileSchema(input.response_format.schema);
  }
  if (input.stream && !profile.capabilities.includes("streaming") || countOnly && !profile.capabilities.includes("token_count")) fault("capability_not_supported", 422);
  if (input.stream && input.response_format) fault("capability_not_supported", 422);
  return { ...input, options, validate };
}
