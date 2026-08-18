import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

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
