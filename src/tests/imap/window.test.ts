import { test } from "node:test";
import assert from "node:assert/strict";
import { imapSearchWindow, inProcessingWindow } from "../../imap/window.js";
test("20:00 CDMX windows partition adjacent days without overlap or dropped edges", () => {
 const start = new Date("2026-10-01T02:00:07.325Z"), end = new Date("2026-10-02T02:00:00Z"), next = new Date("2026-10-03T02:00:00Z");
 const candidates = [new Date(start.getTime()-1), start, new Date("2026-10-01T23:59:59Z"), new Date(end.getTime()-1), end];
 assert.deepEqual(candidates.filter(d=>inProcessingWindow(d,start,end)), candidates.slice(1,4));
 assert.equal(inProcessingWindow(end,end,next),true);
 const query=imapSearchWindow(start,end);
 assert.ok(query.since < candidates[0]); assert.ok(query.before > end);
 assert.throws(()=>imapSearchWindow(end,start),/Invalid/);
});
