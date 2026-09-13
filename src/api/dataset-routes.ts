/**
 * GET /api/datasets/*: the training dataset export (docs/training-data.md,
 * docs/frontend-contract.md). Rows are rebuilt from the dataset store on
 * every request, for the query's window (`days`) and `mode`.
 */
import type { FastifyInstance } from "fastify";
import { buildDatasetRows, DATASET_FILES, toJsonl, type DatasetRows } from "../dataset/build.js";
import type { DatasetStore } from "../dataset/store.js";
import { buildDatasetZip } from "../dataset/zip.js";
import type { DatasetManifest, ServerMode } from "./dto.js";
import { parseDays, parseEvaluationMode } from "./spectator-routes.js";

const DAY_MS = 86_400_000;

type DatasetQuery = { days?: string; mode?: string };

export type DatasetRouteContext = {
  store: DatasetStore;
  now: () => number;
  /** The default `mode`. */
  mode: ServerMode;
};

/** The UTC day of `at`, as YYYY-MM-DD. */
function utcDay(at: number): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "undated" : date.toISOString().slice(0, 10);
}

/** `sabotage-markets-dataset-YYYY-MM-DD.zip`. */
export function datasetZipFilename(at: number): string {
  return `sabotage-markets-dataset-${utcDay(at)}.zip`;
}

export function registerDatasetRoutes(app: FastifyInstance, context: DatasetRouteContext): void {
  const rowsFor = async (query: DatasetQuery): Promise<{ at: number; rows: DatasetRows }> => {
    const at = context.now();
    const days = parseDays(query.days);
    const mode = parseEvaluationMode(query.mode, context.mode);
    const records = await context.store.list({
      since: at - days * DAY_MS,
      mode: mode === "all" ? undefined : mode,
    });
    return { at, rows: buildDatasetRows(records, { now: at, days, mode }) };
  };

  app.get<{ Querystring: DatasetQuery }>("/api/datasets/export.zip", async (request, reply) => {
    const { at, rows } = await rowsFor(request.query);
    const zip = await buildDatasetZip(rows, context.store);
    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${datasetZipFilename(at)}"`)
      .header("Cache-Control", "no-store")
      .send(Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength));
  });

  app.get<{ Querystring: DatasetQuery }>(
    "/api/datasets/manifest.json",
    async (request, reply): Promise<DatasetManifest> => {
      const { rows } = await rowsFor(request.query);
      reply.header("Cache-Control", "no-store");
      return rows.manifest;
    },
  );

  for (const file of DATASET_FILES) {
    app.get<{ Querystring: DatasetQuery }>(`/api/datasets/${file}.jsonl`, async (request, reply) => {
      const { at, rows } = await rowsFor(request.query);
      return reply
        .header("Content-Type", "application/x-ndjson")
        .header("Content-Disposition", `attachment; filename="sabotage-markets-${file}-${utcDay(at)}.jsonl"`)
        .header("Cache-Control", "no-store")
        .send(toJsonl(rows[file]));
    });
  }
}
