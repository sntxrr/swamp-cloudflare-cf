/**
 * cf activity report — a model-scope report that summarizes what a
 * `@sntxrr/cloudflare-cf` model has done: how many operations were reads,
 * dry-runs and applied writes, which commands ran, and every applied write.
 * It reads every retained version of the model's `result` records (one per
 * `run`), so the history spans the data's garbage-collection window rather
 * than just the latest call. `search`, `operation` and `identity` records are
 * ignored.
 *
 * @module
 */
// extensions/reports/cf_activity.ts
import { z } from "npm:zod@4";

/** The subset of a stored `result` record this report reads. */
const ResultSchema = z.object({
  command: z.string(),
  httpMethod: z.string(),
  mode: z.enum(["read", "dry-run", "apply"]),
  ranAt: z.string(),
  truncated: z.boolean().optional(),
});

type Result = z.infer<typeof ResultSchema>;

type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
};

/** Minimal view of the model-scope report context this report relies on. */
type ModelReportContext = {
  modelType: string;
  modelId: string;
  definition?: { name?: string };
  logger: Logger;
  dataRepository: {
    findAllForModel: (
      type: string,
      modelId: string,
    ) => Promise<Array<{ name: string; version?: number }>>;
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
};

type ModeCounts = { read: number; "dry-run": number; apply: number };

/** Load every retained version of every `result` record for a model. */
async function loadResults(context: ModelReportContext): Promise<Result[]> {
  const { modelType, modelId, dataRepository } = context;
  const all = await dataRepository.findAllForModel(modelType, modelId);

  // findAllForModel lists only the latest version of each data name, but
  // every run writes a new version. Walk each name down from its latest
  // version until the older versions have been garbage-collected. Skip report
  // artifacts.
  const latest = new Map<string, number>();
  for (const d of all) {
    if (d.name.startsWith("report-")) continue;
    latest.set(d.name, Math.max(latest.get(d.name) ?? 0, d.version ?? 1));
  }

  const results: Result[] = [];
  for (const [name, top] of latest) {
    for (let version = top; version >= 1; version--) {
      const bytes = await dataRepository.getContent(
        modelType,
        modelId,
        name,
        version,
      );
      if (!bytes) break; // older versions were garbage-collected
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        continue;
      }
      // Only `result` records carry `mode` + `ranAt`; the others fail this
      // parse and are skipped.
      const r = ResultSchema.safeParse(parsed);
      if (r.success) results.push(r.data);
    }
  }
  return results.sort((a, b) => a.ranAt.localeCompare(b.ranAt));
}

/**
 * cf activity report definition. Model-scope, so it runs after the model's
 * method executions and can be fetched with
 * `swamp report get @sntxrr/cf-activity --model <name>`.
 */
export const report = {
  name: "@sntxrr/cf-activity",
  description:
    "Summarize cf CLI activity for a model — reads, dry-runs and applied writes, per-command counts, and a log of every applied write",
  scope: "model" as const,
  labels: ["cloudflare", "audit", "cf"],
  execute: async (
    context: ModelReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const modelName = context.definition?.name ?? context.modelId;
    const results = await loadResults(context);

    const totals: ModeCounts = { read: 0, "dry-run": 0, apply: 0 };
    const byCommand = new Map<string, ModeCounts & { method: string }>();
    for (const r of results) {
      totals[r.mode] += 1;
      const c = byCommand.get(r.command) ??
        { read: 0, "dry-run": 0, apply: 0, method: r.httpMethod };
      c[r.mode] += 1;
      byCommand.set(r.command, c);
    }
    const applied = results.filter((r) => r.mode === "apply");

    context.logger.info(
      "cf activity report: {runs} run(s), {applied} applied write(s)",
      { runs: results.length, applied: applied.length },
    );

    const lines: string[] = [];
    lines.push(`## cf activity — ${modelName}`);
    lines.push("");
    if (results.length === 0) {
      lines.push("No `run` activity recorded for this model.");
    } else {
      lines.push(
        `**${results.length}** run(s) · **${totals.read}** read · **${
          totals["dry-run"]
        }** dry-run · **${totals.apply}** applied write(s)`,
      );
      lines.push("");
      lines.push("| Command | Method | Read | Dry-run | Applied |");
      lines.push("| ------- | ------ | ---: | ------: | ------: |");
      for (
        const [cmd, c] of [...byCommand.entries()].sort((a, b) =>
          a[0].localeCompare(b[0])
        )
      ) {
        lines.push(
          `| \`${cmd}\` | ${c.method} | ${c.read} | ${
            c["dry-run"]
          } | ${c.apply} |`,
        );
      }

      if (applied.length > 0) {
        lines.push("");
        lines.push("### Applied writes");
        lines.push("");
        lines.push("| When | Method | Command |");
        lines.push("| ---- | ------ | ------- |");
        for (const r of applied) {
          lines.push(`| ${r.ranAt} | ${r.httpMethod} | \`${r.command}\` |`);
        }
      }
    }

    return {
      markdown: lines.join("\n") + "\n",
      json: {
        model: modelName,
        runs: results.length,
        totals,
        byCommand: Object.fromEntries(byCommand),
        appliedWrites: applied.map((r) => ({
          command: r.command,
          httpMethod: r.httpMethod,
          ranAt: r.ranAt,
        })),
      },
    };
  },
};
