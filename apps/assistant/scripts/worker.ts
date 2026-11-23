import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openDatabase } from "../src/db/store";
import { claim, complete, recoverExpired, start } from "../src/runtime/attempts";

const db = openDatabase(resolve(process.env["ASSISTANT_DB_PATH"] ?? "./data/assistant.sqlite"));
const workerId = randomUUID();
const once = process.argv.includes("--once");
try {
  do {
    recoverExpired(db);
    const attempt = claim(db, workerId);
    if (attempt) {
      if (!start(db, attempt, workerId)) continue;
      const result = attempt.executor_kind === "sha256"
        ? { status: "succeeded" as const, output: createHash("sha256").update(attempt.goal).digest("hex") }
        : { status: "failed" as const, output: "Executor not registered" };
      complete(db, attempt, workerId, result);
    } else if (!once) {
      await Bun.sleep(1000);
    }
  } while (!once);
} finally {
  db.close();
}
