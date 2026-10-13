export default async (ctx) => {
  const text = await ctx.read("brand.json");
  if (text === null) return { ok: false, message: "brand.json is missing." };
  const brand = JSON.parse(text);
  const ok = ["name", "slug", "mark"].every(key => typeof brand[key] === "string" && brand[key].trim().length > 0);
  return { ok, message: ok ? "Brand fields are valid." : "Brand name, slug and mark must be non-empty strings." };
};
