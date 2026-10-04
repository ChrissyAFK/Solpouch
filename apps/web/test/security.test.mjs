import assert from "node:assert/strict";
import { test } from "node:test";
import { contentSecurityPolicy } from "../security.mjs";

const options = {
  nonce: "test-nonce",
  development: false,
  secure: true,
  backendUrl: "https://api.example.test/v1",
};

test("production scripts require a nonce and do not allow inline code or eval", () => {
  const policy = contentSecurityPolicy(options);
  const scripts = policy
    .split("; ")
    .find((part) => part.startsWith("script-src "));
  assert.match(scripts, /'nonce-test-nonce' 'strict-dynamic'/);
  assert.doesNotMatch(scripts, /unsafe-inline|unsafe-eval/);
  assert.match(policy, /connect-src 'self' https:\/\/api\.example\.test https:\/\/api\.elevenlabs\.io wss:\/\/api\.elevenlabs\.io https:\/\/accounts\.google\.com\/gsi\/;/);
  assert.match(scripts, /https:\/\/accounts\.google\.com\/gsi\/client/);
  assert.match(policy, /frame-src https:\/\/accounts\.google\.com\/gsi\/;/);
  assert.match(policy, /style-src 'self' 'unsafe-inline' https:\/\/accounts\.google\.com\/gsi\/style;/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /upgrade-insecure-requests/);
});

test("development supports hot reload but HTTP local previews are not upgraded", () => {
  const policy = contentSecurityPolicy({
    ...options,
    development: true,
    secure: false,
  });
  assert.match(policy, /'unsafe-eval'/);
  assert.match(policy, /ws: wss:/);
  assert.doesNotMatch(policy, /upgrade-insecure-requests/);
});

test("backend origins cannot inject directives or non-HTTP protocols", () => {
  for (const backendUrl of [
    "data:text/plain,hello",
    "https://user:password@example.test",
    "https://bad host; script-src *",
  ]) {
    assert.throws(() => contentSecurityPolicy({ ...options, backendUrl }));
  }
});
