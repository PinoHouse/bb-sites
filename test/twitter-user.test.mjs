import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function loadUserAdapter(result) {
  const source = await readFile(
    new URL("../twitter/user.js", import.meta.url),
    "utf8",
  );
  const patched = source.replace(
    /async function\s*\(\s*args\s*\)\s*\{/,
    "globalThis.__adapter = async function(args) {",
  );
  const context = vm.createContext({
    document: { cookie: "ct0=test" },
    decodeURIComponent,
    encodeURIComponent,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { user: { result } } }),
    }),
    findGraphQLQueryId: () => "dynamic-user-id",
    globalThis: {},
  });
  vm.runInContext(patched, context, { filename: "twitter/user.js" });
  return context.globalThis.__adapter;
}

test("user reads identity fields from the current core envelope", async () => {
  const adapter = await loadUserAdapter({
    rest_id: "1565028828329971713",
    core: {
      name: "Shruti",
      screen_name: "heyshrutimishra",
    },
    profile_bio: {
      description: "Building digital leverage with AI",
    },
    relationship_counts: { followers: 181838, following: 997 },
    tweet_counts: { tweets: 42600 },
    is_blue_verified: true,
  });

  const result = await adapter({ screen_name: "heyshrutimishra" });

  assert.equal(result.name, "Shruti");
  assert.equal(result.screen_name, "heyshrutimishra");
  assert.equal(result.url, "https://x.com/heyshrutimishra");
  assert.equal(result.bio, "Building digital leverage with AI");
  assert.equal(result.followers, 181838);
  assert.equal(result.following, 997);
  assert.equal(result.tweets, 42600);
});
