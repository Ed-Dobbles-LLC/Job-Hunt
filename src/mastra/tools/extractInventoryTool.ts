import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { extractFactRegistry, serializeRegistry } from "./factRegistry";

export const extractInventoryTool = createTool({
  id: "extract-inventory",
  description:
    "Extracts a FactRegistry from the experience inventory. This MUST be called before generating any application materials. It builds an indexed allowlist of all employers, titles, dates, tools, degrees, certifications, and metrics. Returns the registry version for downstream verification.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    version: z.string(),
    extractedAt: z.string(),
    stats: z.object({
      employers: z.number(),
      titles: z.number(),
      dates: z.number(),
      metrics: z.number(),
      tools: z.number(),
      degrees: z.number(),
      certifications: z.number(),
      bullets: z.number(),
      totalAtoms: z.number(),
    }),
  }),
  execute: async ({ mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📋 [extractInventory] Building FactRegistry from inventory");

    const registry = extractFactRegistry();
    const serialized = serializeRegistry(registry);

    logger?.info(`📋 [extractInventory] Registry built: ${registry.atoms.length} atoms`);
    logger?.info(`📋 [extractInventory] Employers: ${registry.employers.size}, Titles: ${registry.titles.size}, Dates: ${registry.dates.size}`);
    logger?.info(`📋 [extractInventory] Metrics: ${registry.metrics.size}, Tools: ${registry.tools.size}, Degrees: ${registry.degrees.size}`);
    logger?.info(`📋 [extractInventory] Certs: ${registry.certifications.size}, Bullets: ${registry.bulletIds.size}`);

    return {
      success: true,
      version: registry.version,
      extractedAt: registry.extractedAt,
      stats: {
        employers: registry.employers.size,
        titles: registry.titles.size,
        dates: registry.dates.size,
        metrics: registry.metrics.size,
        tools: registry.tools.size,
        degrees: registry.degrees.size,
        certifications: registry.certifications.size,
        bullets: registry.bulletIds.size,
        totalAtoms: registry.atoms.length,
      },
    };
  },
});
