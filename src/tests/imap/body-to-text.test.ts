import { test } from "node:test";
import assert from "node:assert/strict";

import { bodyToText, looksLikeHtml } from "../../imap/poller.js";

test("real plain text is passed through untouched", () => {
  const t = "Recibiste $5,000.00 MN\nCuenta receptora: *******4615";
  assert.equal(bodyToText(t, undefined), t);
});

test("HTML hiding in the text/plain part is flattened, not shipped raw", () => {
  // Openbank and DolarApp both do this: a non-empty text part full of markup.
  const html = '<!DOCTYPE html><html><head><title>Estado</title><style>a{}</style></head>' +
    "<body><p>Recibiste $5,000.00</p></body></html>";
  const out = bodyToText(html, undefined);
  assert.equal(looksLikeHtml(out), false);
  assert.match(out, /Recibiste \$5,000\.00/);
  assert.doesNotMatch(out, /DOCTYPE|<p>|<style>/);
});

test("head content does not leak into the flattened body", () => {
  const out = bodyToText(undefined, "<html><head><title>NO LEAK</title></head><body>ok</body></html>");
  assert.doesNotMatch(out, /NO LEAK/);
  assert.match(out, /ok/);
});

test("falls back to the html part when there is no text part", () => {
  assert.match(bodyToText(undefined, "<div>Compra por $10</div>"), /Compra por \$10/);
});

test("empty input yields an empty string, never undefined", () => {
  assert.equal(bodyToText(undefined, undefined), "");
  assert.equal(bodyToText("", ""), "");
});
