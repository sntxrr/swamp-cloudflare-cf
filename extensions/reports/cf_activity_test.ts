// extensions/reports/cf_activity_test.ts
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { createReportTestContext } from "jsr:@swamp-club/swamp-testing@0.20260923.37";
import { report } from "./cf_activity.ts";

type ActivityReportContext = Parameters<typeof report.execute>[0];

const MODEL_TYPE = "@sntxrr/cloudflare-cf";
const MODEL_ID = "example-account";

function artifact(name: string, version: number, rec: Record<string, unknown>) {
  const content = new TextEncoder().encode(JSON.stringify(rec));
  return {
    modelType: MODEL_TYPE,
    modelId: MODEL_ID,
    data: {
      name,
      kind: "resource" as const,
      dataId: name,
      version,
      size: content.length,
      contentType: "application/json",
    },
    content,
  };
}

function result(
  command: string,
  httpMethod: string,
  mode: string,
  ranAt: string,
): Record<string, unknown> {
  return {
    command,
    argv: [],
    operationId: "op",
    httpMethod,
    mode,
    exitCode: 0,
    output: null,
    outputText: null,
    truncated: false,
    ranAt,
  };
}

function reportContext(dataArtifacts: ReturnType<typeof artifact>[]) {
  const { context } = createReportTestContext({
    scope: "model",
    modelType: MODEL_TYPE,
    modelId: MODEL_ID,
    methodName: "run",
    executionStatus: "succeeded",
    dataHandles: [],
    dataArtifacts,
  });
  return context as unknown as ActivityReportContext;
}

// Live swamp's findAllForModel lists only the latest version of each data
// name; the swamp-testing fake lists every version. Wrap it to match live.
function latestOnlyContext(dataArtifacts: ReturnType<typeof artifact>[]) {
  const context = reportContext(dataArtifacts);
  const repo = context.dataRepository;
  const findAll = repo.findAllForModel.bind(repo);
  repo.findAllForModel = async (type: string, id: string) => {
    const top = new Map<string, { name: string; version?: number }>();
    for (const d of await findAll(type, id)) {
      const prev = top.get(d.name);
      if (!prev || (d.version ?? 0) > (prev.version ?? 0)) top.set(d.name, d);
    }
    return [...top.values()];
  };
  return context;
}

Deno.test("cf-activity counts every version by mode and lists applied writes", async () => {
  const ctx = reportContext([
    artifact(
      "current",
      1,
      result("cf dns records list", "GET", "read", "2026-09-28T10:00:00Z"),
    ),
    artifact(
      "current",
      2,
      result(
        "cf dns records create",
        "POST",
        "dry-run",
        "2026-09-28T10:01:00Z",
      ),
    ),
    artifact(
      "current",
      3,
      result("cf dns records create", "POST", "apply", "2026-09-28T10:02:00Z"),
    ),
    artifact(
      "audit",
      1,
      result("cf dns records list", "GET", "read", "2026-09-28T09:00:00Z"),
    ),
    // Non-result records are ignored.
    artifact("found", 1, { query: "list dns", matches: [], searchedAt: "x" }),
  ]);

  const out = await report.execute(ctx);
  assertEquals(out.json.runs, 4);
  assertEquals(out.json.totals, { read: 2, "dry-run": 1, apply: 1 });
  assertEquals((out.json.appliedWrites as unknown[]).length, 1);
  assertStringIncludes(out.markdown, "### Applied writes");
  assertStringIncludes(
    out.markdown,
    "| `cf dns records create` | POST | 0 | 1 | 1 |",
  );
});

Deno.test("cf-activity reports an empty model", async () => {
  const out = await report.execute(reportContext([]));
  assertEquals(out.json.runs, 0);
  assertStringIncludes(out.markdown, "No `run` activity");
});

Deno.test("cf-activity counts every retained version when only the latest is listed", async () => {
  const out = await report.execute(latestOnlyContext([
    artifact(
      "result",
      1,
      result("cf zones list", "GET", "read", "2026-09-29T10:00:00Z"),
    ),
    artifact(
      "result",
      2,
      result("cf zones list", "GET", "read", "2026-09-29T10:01:00Z"),
    ),
  ]));
  assertEquals(out.json.runs, 2);
  assertEquals(out.json.totals, { read: 2, "dry-run": 0, apply: 0 });
});

Deno.test("cf-activity stops at the garbage-collected floor", async () => {
  // Versions 1-2 were garbage-collected; only 3-4 remain on disk.
  const out = await report.execute(latestOnlyContext([
    artifact(
      "result",
      3,
      result("cf zones list", "GET", "read", "2026-09-29T10:00:00Z"),
    ),
    artifact(
      "result",
      4,
      result("cf dns records create", "POST", "apply", "2026-09-29T10:01:00Z"),
    ),
  ]));
  assertEquals(out.json.runs, 2);
  assertEquals(out.json.totals, { read: 1, "dry-run": 0, apply: 1 });
});
