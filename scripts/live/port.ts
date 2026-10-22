// CDP port for the isolated Cannoli test instance. Other agents drive Obsidian on
// 9333–9340 and 9342, so refuse those even if CDP_PORT is set to one by mistake.
const RESERVED = new Set([9333, 9334, 9335, 9336, 9337, 9338, 9339, 9340, 9342]);

export function cdpPort(): string {
  const port = Number(process.env.CDP_PORT ?? 9346);
  if (RESERVED.has(port)) {
    console.error(`refusing CDP port ${port}: reserved for other Obsidian instances`);
    process.exit(2);
  }
  return String(port);
}
