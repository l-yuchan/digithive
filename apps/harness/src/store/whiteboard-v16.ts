import type { Database } from "bun:sqlite";
import type { Transition } from "./migrations";
import { WHITEBOARD_SCHEMA_SQL } from "../whiteboard/sqlite-index";
import { installSystemWorkflows } from "../workflows/system-workflows";

/** Whiteboard index, canonical briefing/search definitions, and their schedules. */
export const V16: Transition = {
  version: 16,
  sql: WHITEBOARD_SCHEMA_SQL,
  run: (db: Database) => {
    installSystemWorkflows(db);
  },
};
