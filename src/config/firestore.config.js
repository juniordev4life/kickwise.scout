import { Firestore } from "@google-cloud/firestore";

let cached;

/**
 * Return a cached Firestore client for the current project.
 *
 * @returns {Firestore} cached client
 *
 * @example
 *   const db = getFirestoreClient();
 *   const snap = await db.collection("users").doc("123").get();
 */
export function getFirestoreClient() {
  if (!cached) {
    cached = new Firestore({
      projectId: process.env.GCP_PROJECT_ID ?? process.env.BQ_PROJECT_ID
    });
  }
  return cached;
}
