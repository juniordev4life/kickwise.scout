import { BigQuery } from "@google-cloud/bigquery";

let cached;

/**
 * Return a cached BigQuery client configured for the Kickwise project.
 *
 * @returns {BigQuery} client instance
 *
 * @example
 *   const bq = getBigQueryClient();
 *   const [rows] = await bq.query("SELECT 1");
 */
export function getBigQueryClient() {
  if (!cached) {
    cached = new BigQuery({
      projectId: process.env.BQ_PROJECT_ID,
      location: process.env.BQ_LOCATION ?? "europe-west3"
    });
  }
  return cached;
}

/**
 * The fully qualified table identifier used in BigQuery SQL statements.
 *
 * @param {string} tableName e.g. "matches"
 * @returns {string} `project.dataset.table`
 *
 * @example
 *   const fqn = bqTable("matches");  //  kickwise-prod.kickwise_main.matches
 */
export function bqTable(tableName) {
  const project = process.env.BQ_PROJECT_ID;
  const dataset = process.env.BQ_DATASET ?? "kickwise_main";
  return `${project}.${dataset}.${tableName}`;
}
