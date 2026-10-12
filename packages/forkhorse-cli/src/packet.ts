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

// Intentionally small YAML subset: top-level scalars and indented lists of strings.
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
    const field = /^([a-z]+):(?: (.*))?$/.exec(line);
    if (!field || Object.hasOwn(result, field[1]!))
      throw new CliError("Invalid or duplicate YAML field.");
    list = undefined;
    if (!field[2]) result[field[1]!] = list = [];
    else result[field[1]!] = scalar(field[2].trim());
  }
  return result;
}

export function packet(text: string): Record<string, unknown> {
  const value: unknown = text.trimStart().startsWith("{") ? JSON.parse(text) : yaml(text);
  const fields = ["id", "title", "goal", "paths", "acceptance"];
  if (!record(value) || Object.keys(value).some((key) => !fields.includes(key)))
    throw new CliError("Packet must contain only id, title, goal, paths and acceptance.");
  slug(typeof value.id === "string" ? value.id : undefined);
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
  // Core is authoritative for path overlap and path grammar; never create claims here.
  return value;
}
