// Decimal MB; leave headroom below the provider's 32 MB per-file limit.
const MAX_BYTES = 10_000_000;

export default async (ctx) => {
  for (const path of await ctx.list("")) {
    const stat = await ctx.stat(path);
    if (stat === null) return { ok: false, message: `File metadata is missing for ${path}.` };
    if (stat.size >= MAX_BYTES) return {
      ok: false,
      message: `${path}: ${stat.size} bytes (10 MB or more); Artifacts limits each file to 32 MB. See docs/large-files.md.`,
    };
  }
  return { ok: true, message: "All files are below 10 MB. See docs/large-files.md for Artifacts limits." };
};
