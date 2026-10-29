import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { reconcileUsage } from "../src/usage";

async function main(): Promise<void> {
  const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT }, `reconcile-usage-${Date.now()}`);
  try {
    const issues = await reconcileUsage(getFirestore(app));
    process.stdout.write(`${JSON.stringify({ mode: "read-only", issueCount: issues.length, issues })}\n`);
    if (issues.length) process.exitCode = 2;
  } finally {
    await deleteApp(app);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
