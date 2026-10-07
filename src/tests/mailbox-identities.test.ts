import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { messageFingerprint, MessageIdentities } from "../imap/message-identities.js";
import { processingFolders } from "../batch/mailboxes.js";

test("discovers localized/renamed Archive by special-use and excludes outgoing/trash", () => {
  assert.deepEqual(processingFolders([
    { path: "INBOX" }, { path: "Mis archivos", specialUse: "\\Archive" },
    { path: "Sent", specialUse: "\\Sent" }, { path: "Trash", specialUse: "\\Trash" },
  ]), ["INBOX", "Mis archivos"]);
  assert.throws(() => processingFolders([{ path: "INBOX" }, { path: "Archive" }]), /missing/);
});
test("moved message deduplicates independently of folder/UID, across restarts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbw-identities-"));
  try {
    const original = Buffer.from("Message-ID: <bank-1>\r\nSubject: Charge\r\n\r\n$150.50\r\n");
    const key = messageFingerprint(original);
    const first = new MessageIdentities(dir, "user@icloud.com");
    assert.equal(first.has(key), false);
    first.add(key);
    assert.equal(new MessageIdentities(dir, " USER@ICLOUD.COM ").has(messageFingerprint(Buffer.from(original.toString().replace(/\r\n/g, "\n")))), true);
    assert.equal(new MessageIdentities(dir, "other@icloud.com").has(key), false);
    // Reused Message-ID with another movement must not suppress it.
    assert.equal(first.has(messageFingerprint(Buffer.from(original.toString().replace("150.50", "750.00")))), false);
    fs.writeFileSync(path.join(dir, fs.readdirSync(dir)[0]), "invalid JSON");
    assert.throws(() => new MessageIdentities(dir, "user@icloud.com"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
