import { bqTable, getBigQueryClient } from "../config/bigQuery.config.js";

/**
 * Idempotent MERGE-upsert of rows into a Kickwise BQ table.
 *
 * The strategy: load rows into a temporary table, then MERGE on the natural
 * key. Repeated runs do not duplicate data.
 *
 * @param {object} params
 * @param {string} params.tableName target table, e.g. "matches"
 * @param {string} params.keyColumn primary key column to merge on, e.g. "match_id"
 * @param {Array<object>} params.rows rows to upsert
 * @param {import("pino").Logger} [params.log]
 * @returns {Promise<{ inserted: number, updated: number }>}
 *
 * @example
 *   const result = await mergeRows({ tableName: "matches", keyColumn: "match_id", rows });
 */
export async function mergeRows({ tableName, keyColumn, rows, log }) {
  if (!rows.length) {
    log?.info({ tableName }, "No rows to merge");
    return { inserted: 0, updated: 0 };
  }

  const bq = getBigQueryClient();
  const dataset = process.env.BQ_DATASET ?? "kickwise_main";
  const dsRef = bq.dataset(dataset);
  const targetTable = dsRef.table(tableName);

  const stagingName = `_staging_${tableName}_${Date.now()}`;
  const staging = dsRef.table(stagingName);

  log?.info({ tableName, count: rows.length, stagingName }, "Loading rows to staging");

  // Mirror schema from target table for the staging table
  const [{ schema }] = await targetTable.getMetadata();
  await dsRef.createTable(stagingName, {
    schema,
    location: process.env.BQ_LOCATION ?? "europe-west3"
  });

  // Load rows via streaming insert; for batch we could use load jobs,
  // but for ~5k rows streaming is fine and avoids a temp file.
  await staging.insert(rows, { skipInvalidRows: false, ignoreUnknownValues: false });

  const columns = schema.fields.map((f) => f.name);
  const updateClauses = columns.filter((c) => c !== keyColumn).map((c) => `T.${c} = S.${c}`);
  const insertColumns = columns.join(", ");
  const insertValues = columns.map((c) => `S.${c}`).join(", ");

  const mergeSql = `
    MERGE \`${bqTable(tableName)}\` AS T
    USING \`${bqTable(stagingName)}\` AS S
    ON T.${keyColumn} = S.${keyColumn}
    WHEN MATCHED THEN UPDATE SET ${updateClauses.join(", ")}
    WHEN NOT MATCHED THEN INSERT (${insertColumns}) VALUES (${insertValues})
  `;

  log?.info({ tableName, mergeOn: keyColumn }, "Running MERGE");

  const [job] = await bq.createQueryJob({
    query: mergeSql,
    location: process.env.BQ_LOCATION ?? "europe-west3"
  });
  await job.getQueryResults();

  await staging.delete({ ignoreNotFound: true });
  log?.info({ tableName }, "MERGE complete, staging dropped");

  return { inserted: rows.length, updated: 0 }; // BQ MERGE-Statistik wäre nice-to-have, hier nicht ausgewertet
}
