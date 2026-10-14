import { open } from "node:fs/promises";
import { CliError, record, slug } from "./safety.ts";

export async function smallFile(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile()) throw new CliError("Input must be a regular file.");
    const bytes = Buffer.alloc(16385);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 16384) throw new CliError("Input file exceeds 16 KiB.");
    return bytes.subarray(0, size).toString("utf8");
  } finally {
    await file.close();
  }
}

// Intentionally small YAML subset: string scalars/lists and a numeric tokenBudget.
// No YAML tags, aliases, flow mappings, multiline values or executable extensions.
function scalar(text: string): string {
  if (!text || /^[&*!>|[{]/.test(text) || /\s+#/.test(text))
    throw new CliError("Unsupported YAML value; use a quoted scalar or JSON.");
  if (text.startsWith('"')) {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "string") throw new CliError("YAML values must be strings.");
    return value;
  }
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) throw new CliError("Invalid quoted YAML value.");
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text;
}

function yaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  let list: string[] | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = /^  - (.+)$/.exec(line);
    if (item && list) {
      list.push(scalar(item[1]!.trim()));
      continue;
    }
    const field = /^([a-zA-Z]+):(?: (.*))?$/.exec(line);
    if (!field || Object.hasOwn(result, field[1]!))
      throw new CliError("Invalid or duplicate YAML field.");
    list = undefined;
    if (!field[2]) result[field[1]!] = list = [];
    else {
      const text = field[2].trim();
      // Only an unquoted JSON number in this numeric field changes scalar type.
      result[field[1]!] =
        field[1] === "tokenBudget" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)
          ? Number(text)
          : scalar(text);
    }
  }
  return result;
}

export function packet(text: string): Record<string, unknown> {
  const value: unknown = text.trimStart().startsWith("{") ? JSON.parse(text) : yaml(text);
  const fields = ["id", "title", "goal", "paths", "acceptance", "mode", "tokenBudget", "judge"];
  if (!record(value) || Object.keys(value).some((key) => !fields.includes(key)))
    throw new CliError(
      "Packet must contain only id, title, goal, paths, acceptance, mode, tokenBudget and judge.",
    );
  slug(typeof value.id === "string" ? value.id : undefined);
  if (value.mode !== undefined && value.mode !== "standard" && value.mode !== "race")
    throw new CliError("Packet mode must be standard or race.");
  if (value.tokenBudget !== undefined) {
    if (value.mode !== "race") throw new CliError("Packet tokenBudget requires mode: race.");
    if (
      typeof value.tokenBudget !== "number" ||
      !Number.isSafeInteger(value.tokenBudget) ||
      value.tokenBudget <= 0
    )
      throw new CliError("Packet tokenBudget must be a positive safe integer.");
  }
  if (value.judge !== undefined) {
    if (value.mode !== "race") throw new CliError("Packet judge requires mode: race.");
    try {
      slug(typeof value.judge === "string" ? value.judge : undefined, 32);
    } catch {
      throw new CliError(
        "Packet judge must be a lowercase agent ID of at most 32 characters with single internal hyphens.",
      );
    }
  }
  for (const [field, max] of [
    ["title", 200],
    ["goal", 4000],
  ] as const) {
    if (typeof value[field] !== "string" || !value[field].trim() || value[field].length > max)
      throw new CliError("Invalid packet title or goal.");
  }
  for (const [field, count, length] of [
    ["paths", 200, 1024],
    ["acceptance", 100, 2000],
  ] as const) {
    const items = value[field];
    if (
      !Array.isArray(items) ||
      !items.length ||
      items.length > count ||
      !items.every((item) => typeof item === "string" && item.trim() && item.length <= length)
    )
      throw new CliError("Invalid packet paths or acceptance list.");
  }
  // Core is authoritative for paths and judge enrollment; never create claims here.
  return value;
}
