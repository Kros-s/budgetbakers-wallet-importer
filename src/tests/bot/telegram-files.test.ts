import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { downloadTelegramFile } from "../../bot/telegram-files.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tgfiles-test-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("the download directory is created rather than assumed", async () => {
  // It used to be os.tmpdir(), which always exists. Pointing it under data/
  // meant the first attachment after a deploy died with ENOENT — and so did
  // every one after it.
  const target = path.join(scratch, "nunca", "existio");
  assert.equal(fs.existsSync(target), false);

  const bot = { telegram: { getFileLink: async () => new URL("http://127.0.0.1:1/f.pdf") } };
  const ctx = { chat: { id: 1 }, message: { message_id: 2 } };
  await downloadTelegramFile(bot as never, ctx as never, "fid", {
    downloadDir: target, mimeType: "application/pdf",
  }).catch(() => { /* la descarga falla a propósito; lo que importa es el mkdir */ });

  assert.equal(fs.existsSync(target), true, "el directorio debe quedar creado");
});
