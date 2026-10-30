import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { renderMarkdown, splitStableMarkdown } from "../public/markdown-enhancer.js";

test("Markdown renderer creates safe rich content without browser observers", () => {
  const output = renderMarkdown("# Title\n\nUse **bold** and [safe](https://example.com).\n\n```js\nconst answer = 42;\n```");

  assert.match(output, /<h1>Title<\/h1>/);
  assert.match(output, /<strong>bold<\/strong>/);
  assert.match(output, /href="https:\/\/example\.com"/);
  assert.match(output, /md-code-block/);
  assert.doesNotMatch(output, /MutationObserver/);
});

test("Markdown renderer rejects unsafe link schemes", () => {
  const output = renderMarkdown("[unsafe](javascript:alert(1))");

  assert.doesNotMatch(output, /javascript:/i);
  assert.doesNotMatch(output, /<a\s/i);
});

test("streaming Markdown only finalizes complete blocks", () => {
  assert.deepEqual(splitStableMarkdown("first paragraph\n\nnext"), {
    completed: "first paragraph\n\n",
    pending: "next",
  });
  assert.deepEqual(splitStableMarkdown("```js\nconst n = 1;\n```\nnext"), {
    completed: "```js\nconst n = 1;\n```\n",
    pending: "next",
  });
});

test("streaming updates are frame-batched and do not use a page-wide observer", async () => {
  const [renderer, app] = await Promise.all([
    readFile(new URL("../public/markdown-enhancer.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(renderer, /new MutationObserver/);
  assert.match(app, /requestAnimationFrame\(flushPendingOutput\)/);
  assert.match(app, /createStreamingMarkdownRenderer\(output\)/);
  assert.match(app, /streamRenderer\.finish\(assistant\)/);
});
