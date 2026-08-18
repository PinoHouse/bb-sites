import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const FIXED_NOW_MS = 1787047200000;
const QUERY = "(NVIDIA OR NVDA) -filter:replies -is:retweet";
const OPERATION_IDS = {
  createInsightInputMutation: "dynamic-create-id",
  usePostCountQuery: "dynamic-count-id",
  deleteInsightButtonMutation: "dynamic-delete-id",
};

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function createResponse(restId = "temporary-rule-123") {
  return jsonResponse({
    data: {
      create_insight_rule_v2: {
        result: { rest_id: restId },
      },
    },
  });
}

function countResponse(matchedPostCounts) {
  return jsonResponse({
    data: {
      viewer_v2: {
        user_results: {
          result: {
            insight_rule_by_id: {
              matched_post_counts: matchedPostCounts,
            },
          },
        },
      },
    },
  });
}

function deleteResponse(restId = "temporary-rule-123") {
  return jsonResponse({
    data: {
      delete_insight_rule_v2: {
        result: { rest_id: restId },
      },
    },
  });
}

function queuedFetch(items) {
  const queue = [...items];
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (queue.length === 0) {
      throw new Error("Unexpected fetch: " + url);
    }
    const item = queue.shift();
    if (item instanceof Error) throw item;
    if (typeof item === "function") return await item(url, options);
    return item;
  };
  return { calls, fetchImpl, queue };
}

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return await handler(url, options, calls.length);
  };
  return { calls, fetchImpl };
}

async function loadRadarAdapter({
  fetchImpl,
  cookie = "ct0=test",
  nowMs = FIXED_NOW_MS,
} = {}) {
  const source = await readFile(
    new URL("../twitter/radar.js", import.meta.url),
    "utf8",
  );
  const patched = source.replace(
    /async function\s*\(\s*args\s*\)\s*\{/,
    "globalThis.__adapter = async function(args) {",
  );
  const clock = { nowMs };
  const NativeDate = Date;
  class FakeDate extends NativeDate {
    constructor(...args) {
      super(...(args.length === 0 ? [clock.nowMs] : args));
    }

    static now() {
      return clock.nowMs;
    }
  }
  const context = vm.createContext({
    Date: FakeDate,
    Math,
    URL,
    console,
    document: { cookie },
    fetch: fetchImpl,
    findGraphQLQueryId(operationName) {
      return OPERATION_IDS[operationName];
    },
    async findTransactionIdGenerator() {
      return async () => "test-transaction-id";
    },
    setTimeout(callback, delayMs) {
      clock.nowMs += delayMs;
      callback();
      return 1;
    },
    clearTimeout() {},
    globalThis: {},
  });
  vm.runInContext(patched, context, { filename: "twitter/radar.js" });
  assert.equal(typeof context.globalThis.__adapter, "function");
  return { adapter: context.globalThis.__adapter, clock };
}

const READY_BUCKETS = [
  { timestamp: 1786492800, count: 1 },
  { timestamp: 1786579200, count: 2 },
  { timestamp: 1786665600, count: 3 },
  { timestamp: 1786752000, count: 4 },
  { timestamp: 1786838400, count: 5 },
  { timestamp: 1786924800, count: 6 },
  { timestamp: 1787011200, count: 7 },
];

async function loadTwitterHelper(moduleSources) {
  const source = await readFile(
    new URL("../twitter/_helper.js", import.meta.url),
    "utf8",
  );
  const modules = {};
  for (const [id, moduleSource] of Object.entries(moduleSources)) {
    const factory = function () {};
    factory.toString = () => moduleSource;
    modules[id] = factory;
  }
  const webpackRequire = function () {};
  webpackRequire.m = modules;
  const context = vm.createContext({
    window: {
      webpackChunk_twitter_responsive_web: {
        push([, , register]) {
          register(webpackRequire);
        },
      },
    },
  });
  vm.runInContext(source, context, { filename: "twitter/_helper.js" });
  return context;
}

test("findGraphQLQueryId discovers an id from a Relay params artifact", async () => {
  const context = await loadTwitterHelper({
    relay:
      'params:{id:"dynamic-create-id",metadata:{},name:"createInsightInputMutation",operationKind:"mutation",text:null}',
  });

  assert.equal(
    context.findGraphQLQueryId("createInsightInputMutation"),
    "dynamic-create-id",
  );
});

test("radar rejects a missing query without issuing a request", async () => {
  const { calls, fetchImpl } = recordingFetch(() => {
    throw new Error("fetch must not be called");
  });
  const { adapter } = await loadRadarAdapter({ fetchImpl });

  assert.deepEqual(plain(await adapter({})), {
    error: "Missing argument: query",
    hint: "Provide a raw X query",
  });
  assert.equal(calls.length, 0);
});

test("radar reports auth_required without fetching when ct0 is absent", async () => {
  const { calls, fetchImpl } = recordingFetch(() => {
    throw new Error("fetch must not be called");
  });
  const { adapter } = await loadRadarAdapter({ fetchImpl, cookie: "" });

  const result = await adapter({ query: QUERY });

  assert.equal(result.status, "auth_required");
  assert.equal(calls.length, 0);
});

test("radar success uses only create, count and exact-id delete operations", async () => {
  const { calls, fetchImpl } = queuedFetch([
    createResponse(),
    countResponse(READY_BUCKETS),
    deleteResponse(),
  ]);
  const { adapter } = await loadRadarAdapter({ fetchImpl });

  const result = await adapter({ query: QUERY });

  assert.equal(result.status, "ok");
  assert.equal(result.cleanup_status, "deleted");
  assert.equal(result.temporary_rule_id, undefined);
  assert.equal(JSON.stringify(result).includes("temporary-rule-123"), false);
  assert.deepEqual(
    calls.map((call) => [new URL(call.url, "https://x.com").pathname, call.options.method]),
    [
      ["/i/api/graphql/dynamic-create-id/createInsightInputMutation", "POST"],
      ["/i/api/graphql/dynamic-count-id/usePostCountQuery", "GET"],
      ["/i/api/graphql/dynamic-delete-id/deleteInsightButtonMutation", "POST"],
    ],
  );
  const createBody = JSON.parse(calls[0].options.body);
  assert.equal(createBody.queryId, "dynamic-create-id");
  assert.equal(createBody.variables.advanced_query, QUERY);
  assert.equal(createBody.variables.notifications_enabled, false);
  assert.equal(createBody.variables.tags, null);
  assert.match(createBody.variables.title, /^CashMaker temporary \d+-/);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    variables: { id: "temporary-rule-123" },
    queryId: "dynamic-delete-id",
  });
  assert.equal(
    calls.some((call) => /List|list|update/i.test(call.url)),
    false,
  );
});

test("radar polls until counts arrive and marks only prior UTC days complete", async () => {
  const { calls, fetchImpl } = queuedFetch([
    createResponse(),
    countResponse([]),
    countResponse(READY_BUCKETS),
    deleteResponse(),
  ]);
  const { adapter, clock } = await loadRadarAdapter({ fetchImpl });

  const result = plain(await adapter({ query: QUERY }));

  assert.deepEqual(result, {
    query: QUERY,
    observed_at: "2026-08-18T10:00:00.000Z",
    window: {
      from: "2026-08-12T00:00:00.000Z",
      to: "2026-08-18T10:00:00.000Z",
      timezone: "UTC",
    },
    total_posts: 28,
    daily_counts: [
      { date: "2026-08-12", count: 1, complete: true },
      { date: "2026-08-13", count: 2, complete: true },
      { date: "2026-08-14", count: 3, complete: true },
      { date: "2026-08-15", count: 4, complete: true },
      { date: "2026-08-16", count: 5, complete: true },
      { date: "2026-08-17", count: 6, complete: true },
      { date: "2026-08-18", count: 7, complete: false },
    ],
    status: "ok",
    cleanup_status: "deleted",
  });
  assert.equal(clock.nowMs, FIXED_NOW_MS + 1000);
  const countCalls = calls.filter((call) => call.url.includes("usePostCountQuery"));
  assert.equal(countCalls.length, 2);
  const countVariables = JSON.parse(
    new URL(countCalls[0].url, "https://x.com").searchParams.get("variables"),
  );
  assert.deepEqual(countVariables, {
    from_time: 1786492800,
    to_time: 1787047200,
    granularity: "Day",
    id: "temporary-rule-123",
    timezone_offset: 0,
  });
});

test("radar preserves explicit zero counts but never invents zero for a missing count", async () => {
  const { fetchImpl } = queuedFetch([
    createResponse(),
    countResponse([
      { timestamp: 1786492800 },
      { timestamp: 1786579200, count: 0 },
    ]),
    deleteResponse(),
  ]);
  const { adapter } = await loadRadarAdapter({ fetchImpl });

  const result = plain(await adapter({ query: QUERY }));

  assert.equal(result.status, "ok");
  assert.equal(result.total_posts, null);
  assert.deepEqual(result.daily_counts, [
    { date: "2026-08-13", count: 0, complete: true },
  ]);
});

for (const [name, transientFailure] of [
  ["a thrown fetch", new Error("socket reset")],
  ["HTTP 503", jsonResponse({ error: "unavailable" }, 503)],
]) {
  test(`radar retries ${name} exactly once`, async () => {
    const { calls, fetchImpl } = queuedFetch([
      transientFailure,
      createResponse(),
      countResponse(READY_BUCKETS),
      deleteResponse(),
    ]);
    const { adapter } = await loadRadarAdapter({ fetchImpl });

    const result = await adapter({ query: QUERY });

    assert.equal(result.status, "ok");
    assert.equal(calls.length, 4);
    assert.equal(calls[0].url, calls[1].url);
  });
}

for (const [httpStatus, expectedStatus] of [
  [401, "auth_required"],
  [403, "entitlement_required"],
  [429, "rate_limited"],
]) {
  test(`radar maps HTTP ${httpStatus} to ${expectedStatus} without retrying`, async () => {
    const { calls, fetchImpl } = queuedFetch([
      jsonResponse({ error: "request rejected" }, httpStatus),
    ]);
    const { adapter } = await loadRadarAdapter({ fetchImpl });

    const result = await adapter({ query: QUERY });

    assert.equal(result.status, expectedStatus);
    assert.equal(calls.length, 1);
    assert.equal(result.cleanup_status, undefined);
  });
}

test("radar returns count_not_ready at the 15-second deadline and still deletes", async () => {
  const { calls, fetchImpl } = recordingFetch((url) => {
    if (url.includes("createInsightInputMutation")) return createResponse();
    if (url.includes("usePostCountQuery")) return countResponse([]);
    if (url.includes("deleteInsightButtonMutation")) return deleteResponse();
    throw new Error("Unexpected operation: " + url);
  });
  const { adapter, clock } = await loadRadarAdapter({ fetchImpl });

  const result = await adapter({ query: QUERY });

  assert.equal(result.status, "count_not_ready");
  assert.equal(result.cleanup_status, "deleted");
  assert.equal(result.temporary_rule_id, undefined);
  assert.equal(clock.nowMs, FIXED_NOW_MS + 15000);
  assert.equal(calls.at(-1).url.includes("deleteInsightButtonMutation"), true);
});

test("radar preserves a typed count failure after successful cleanup", async () => {
  const { calls, fetchImpl } = queuedFetch([
    createResponse(),
    jsonResponse({ error: "too many requests" }, 429),
    deleteResponse(),
  ]);
  const { adapter } = await loadRadarAdapter({ fetchImpl });

  const result = await adapter({ query: QUERY });

  assert.equal(result.status, "rate_limited");
  assert.equal(result.cleanup_status, "deleted");
  assert.equal(result.temporary_rule_id, undefined);
  assert.equal(calls.length, 3);
});

test("radar exposes the exact temporary rule only when cleanup fails", async () => {
  const { calls, fetchImpl } = queuedFetch([
    createResponse(),
    jsonResponse({ error: "too many requests" }, 429),
    jsonResponse({ error: "unavailable" }, 503),
    jsonResponse({ error: "unavailable" }, 503),
  ]);
  const { adapter } = await loadRadarAdapter({ fetchImpl });

  const result = plain(await adapter({ query: QUERY }));

  assert.deepEqual(result, {
    status: "cleanup_required",
    cleanup_status: "failed",
    temporary_rule_id: "temporary-rule-123",
    temporary_query: QUERY,
    cause_status: "rate_limited",
  });
  const deleteCalls = calls.filter((call) =>
    call.url.includes("deleteInsightButtonMutation"),
  );
  assert.equal(deleteCalls.length, 2);
  for (const call of deleteCalls) {
    assert.equal(
      JSON.parse(call.options.body).variables.id,
      "temporary-rule-123",
    );
  }
});
