import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const IDS = {
  SearchTimeline: "dynamic-search-id",
  createInsightInputMutation: "dynamic-create-id",
  usePostCountQuery: "dynamic-count-id",
  deleteInsightButtonMutation: "dynamic-delete-id",
};

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function fakeWebpack() {
  const factories = {};
  const exportsById = {};
  for (const [name, id] of Object.entries(IDS)) {
    const factory = function () {};
    factory.toString = () =>
      `params:{id:"${id}",metadata:{},name:"${name}",operationKind:"query",text:null}`;
    factories[`op-${name}`] = factory;
  }
  const transactionFactory = function () {};
  transactionFactory.toString = () =>
    '"x-client-transaction-id";"rweb_client_transaction_id_enabled"';
  factories.transaction = transactionFactory;
  exportsById.transaction = {
    generate: async () => "t".repeat(80),
  };

  const webpackRequire = (id) => exportsById[id] || {};
  webpackRequire.m = factories;
  return webpackRequire;
}

async function loadAdapter(filename, fetchImpl) {
  const source = await readFile(
    new URL(`../twitter/${filename}`, import.meta.url),
    "utf8",
  );
  const patched = source.replace(
    /async function\s*\(\s*args\s*\)\s*\{/,
    "globalThis.__adapter = async function(args) {",
  );
  const webpackRequire = fakeWebpack();
  const context = vm.createContext({
    Date,
    Math,
    URL,
    atob,
    decodeURIComponent,
    encodeURIComponent,
    document: { cookie: "ct0=test" },
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    window: {
      webpackChunk_twitter_responsive_web: {
        push([, , register]) {
          register(webpackRequire);
        },
      },
    },
    globalThis: {},
  });
  vm.runInContext(patched, context, { filename: `twitter/${filename}` });
  return context.globalThis.__adapter;
}

test("radar discovers operations when the runtime does not inject _helper.js", async () => {
  const urls = [];
  const responses = [
    jsonResponse({
      data: { create_insight_rule_v2: { result: { rest_id: "temp-1" } } },
    }),
    jsonResponse({
      data: {
        viewer_v2: {
          user_results: {
            result: {
              insight_rule_by_id: {
                matched_post_counts: {
                  counts: [{ start_time: 1786492800, count: 1 }],
                  total: 1,
                },
              },
            },
          },
        },
      },
    }),
    jsonResponse({
      data: { delete_insight_rule_v2: { result: { rest_id: "temp-1" } } },
    }),
  ];
  const adapter = await loadAdapter("radar.js", async (url) => {
    urls.push(url);
    return responses.shift();
  });

  const result = await adapter({ query: "CashMaker compat probe" });

  assert.equal(result.status, "ok", JSON.stringify({ result, urls }));
  assert.equal(result.cleanup_status, "deleted");
  assert.deepEqual(
    urls.map((url) => new URL(url, "https://x.com").pathname),
    [
      "/i/api/graphql/dynamic-create-id/createInsightInputMutation",
      "/i/api/graphql/dynamic-count-id/usePostCountQuery",
      "/i/api/graphql/dynamic-delete-id/deleteInsightButtonMutation",
    ],
  );
});

test("search discovers its operation and transaction generator without _helper.js", async () => {
  const calls = [];
  const adapter = await loadAdapter("search.js", async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({
      data: {
        search_by_raw_query: {
          search_timeline: { timeline: { instructions: [] } },
        },
      },
    });
  });

  const result = await adapter({ query: "NVIDIA", count: "5", type: "top" });

  assert.equal(result.count, 0);
  assert.equal(
    new URL(calls[0].url, "https://x.com").pathname,
    "/i/api/graphql/dynamic-search-id/SearchTimeline",
  );
  assert.equal(calls[0].options.headers["X-Client-Transaction-Id"].length, 80);
});

test("thread uses its verified fallback id without _helper.js", async () => {
  let requestUrl;
  const adapter = await loadAdapter("thread.js", async (url) => {
    requestUrl = url;
    return jsonResponse({
      data: { threaded_conversation_with_injections_v2: { instructions: [] } },
    });
  });

  const result = await adapter({ tweet_id: "2089656651053990367" });

  assert.equal(result.count, 0);
  assert.equal(
    new URL(requestUrl, "https://x.com").pathname,
    "/i/api/graphql/nBS-WpgA6ZG0CyNHD517JQ/TweetDetail",
  );
});

test("user uses its verified fallback id without _helper.js", async () => {
  let requestUrl;
  const adapter = await loadAdapter("user.js", async (url) => {
    requestUrl = url;
    return jsonResponse({
      data: {
        user: {
          result: {
            rest_id: "1565028828329971713",
            core: { name: "Shruti", screen_name: "heyshrutimishra" },
            profile_bio: { description: "AI" },
            relationship_counts: { followers: 10, following: 2 },
            tweet_counts: { tweets: 3 },
            is_blue_verified: true,
          },
        },
      },
    });
  });

  const result = await adapter({ screen_name: "heyshrutimishra" });

  assert.equal(result.url, "https://x.com/heyshrutimishra");
  assert.equal(
    new URL(requestUrl, "https://x.com").pathname,
    "/i/api/graphql/pLsOiyHJ1eFwPJlNmLp4Bg/UserByScreenName",
  );
});
