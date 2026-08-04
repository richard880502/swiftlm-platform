import test from "node:test";
import assert from "node:assert/strict";
import {
  bearerToken,
  createSessionCookie,
  hmacHex,
  issueApiKey,
  verifyAdminPassword,
  verifySessionCookie,
} from "../src/auth.js";

test("admin password comparison", () => {
  assert.equal(verifyAdminPassword("correct horse", "correct horse"), true);
  assert.equal(verifyAdminPassword("wrong", "correct horse"), false);
});

test("session cookie is signed and expires safely", () => {
  const token = createSessionCookie("session-secret", 1);
  assert.equal(verifySessionCookie("session-secret", token), true);
  assert.equal(verifySessionCookie("different-secret", token), false);
  assert.equal(verifySessionCookie("session-secret", `${token}x`), false);
});

test("issued API keys have expected prefix and stable HMAC", () => {
  const issued = issueApiKey();
  assert.match(issued.value, /^sk-mlx-/);
  assert.equal(hmacHex("secret", issued.value), hmacHex("secret", issued.value));
});

test("bearer token parsing", () => {
  assert.equal(bearerToken("Bearer sk-mlx-test"), "sk-mlx-test");
  assert.equal(bearerToken("Basic abc"), "");
});
