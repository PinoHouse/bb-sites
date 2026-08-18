/* @meta
{
  "name": "twitter/radar",
  "description": "获取 X Radar 七日讨论量（临时规则会自动删除）",
  "domain": "x.com",
  "args": {
    "query": {"required": true, "description": "Raw X advanced-search query"}
  },
  "capabilities": ["network"],
  "readOnly": false,
  "example": "bb-browser site twitter/radar \"(NVIDIA OR NVDA) -filter:replies -is:retweet\""
}
*/

async function(args) {
  if (!args.query || !String(args.query).trim()) {
    return {error: 'Missing argument: query', hint: 'Provide a raw X query'};
  }

  const query = String(args.query);
  const ct0 = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('ct0='))?.split('=')[1];
  if (!ct0) return {query, status: 'auth_required'};

  function classifyHttpStatus(status) {
    if (status === 401) return 'auth_required';
    if (status === 403) return 'entitlement_required';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'network_error';
    return 'upstream_changed';
  }

  function classifyRelayFailure(payload) {
    if (!Array.isArray(payload?.errors) || payload.errors.length === 0) return null;
    const details = JSON.stringify(payload.errors).toLowerCase();
    if (details.includes('rate') || details.includes('too many requests')) return 'rate_limited';
    if (details.includes('premium') || details.includes('entitle') || details.includes('forbidden')) return 'entitlement_required';
    if (details.includes('auth') || details.includes('unauthorized') || details.includes('login')) return 'auth_required';
    return 'upstream_changed';
  }

  function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function normalizeCounts(buckets, utcTodayStartMs, sourceTotal) {
    const dailyCounts = [];
    let total = 0;
    let complete = true;

    for (const bucket of buckets) {
      if (typeof bucket?.count !== 'number' || !Number.isFinite(bucket.count)) {
        complete = false;
        continue;
      }
      const rawTimestamp = bucket.start_time ?? bucket.timestamp;
      const timestampMs = typeof rawTimestamp === 'number'
        ? (rawTimestamp < 1000000000000 ? rawTimestamp * 1000 : rawTimestamp)
        : Date.parse(rawTimestamp);
      if (!Number.isFinite(timestampMs)) {
        complete = false;
        continue;
      }
      dailyCounts.push({
        date: new Date(timestampMs).toISOString().slice(0, 10),
        count: bucket.count,
        complete: timestampMs < utcTodayStartMs
      });
      total += bucket.count;
    }

    dailyCounts.sort((left, right) => left.date.localeCompare(right.date));
    return {
      usable: dailyCounts.length > 0,
      daily_counts: dailyCounts,
      total_posts: typeof sourceTotal === 'number' && Number.isFinite(sourceTotal)
        ? sourceTotal
        : (complete && dailyCounts.length === buckets.length ? total : null)
    };
  }

  function getWebpackRequire() {
    let webpackRequire;
    window.webpackChunk_twitter_responsive_web.push(
      [['__bb_radar_compat_' + Date.now()], {}, req => { webpackRequire = req; }]
    );
    return webpackRequire;
  }

  function discoverQueryId(operationName) {
    try {
      const req = getWebpackRequire();
      const op = operationName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const patterns = [
        new RegExp('queryId:\\s*"([^"]+)"\\s*,\\s*operationName:\\s*"' + op + '"'),
        new RegExp('operationName:\\s*"' + op + '"\\s*,\\s*queryId:\\s*"([^"]+)"'),
        new RegExp('params:\\s*\\{\\s*id:\\s*"([^"]+)"\\s*,\\s*metadata:\\s*\\{[^}]*\\}\\s*,\\s*name:\\s*"' + op + '"'),
        new RegExp('name:\\s*"' + op + '"[^}]*operationKind:\\s*"(?:query|mutation)"[^}]*id:\\s*"([^"]+)"')
      ];
      for (const id of Object.keys(req.m)) {
        try {
          const source = req.m[id].toString();
          if (!source.includes(operationName)) continue;
          for (const pattern of patterns) {
            const match = source.match(pattern);
            if (match) return match[1];
          }
        } catch {}
      }
    } catch {}
    return undefined;
  }

  async function discoverTransactionIdGenerator() {
    try {
      const req = getWebpackRequire();
      for (const id of Object.keys(req.m)) {
        try {
          const source = req.m[id].toString();
          if (!source.includes('x-client-transaction-id') || !source.includes('rweb_client_transaction_id_enabled')) continue;
          const moduleExports = req(id);
          for (const candidate of Object.values(moduleExports)) {
            if (typeof candidate !== 'function') continue;
            try {
              const sample = await candidate('x.com', '/i/api/graphql/test/Op', 'GET');
              if (typeof sample !== 'string' || sample.length < 40) continue;
              try { if (atob(sample).startsWith('e:')) continue; } catch {}
              return candidate;
            } catch {}
          }
        } catch {}
      }
    } catch {}
    return null;
  }

  const queryIdResolver = typeof findGraphQLQueryId === 'function'
    ? findGraphQLQueryId
    : discoverQueryId;
  const transactionIdResolver = typeof findTransactionIdGenerator === 'function'
    ? findTransactionIdGenerator
    : discoverTransactionIdGenerator;

  let operationIds;
  let transactionIdGenerator;
  try {
    operationIds = {
      create: queryIdResolver('createInsightInputMutation'),
      count: queryIdResolver('usePostCountQuery'),
      delete: queryIdResolver('deleteInsightButtonMutation')
    };
    transactionIdGenerator = await transactionIdResolver();
  } catch {
    return {query, status: 'upstream_changed'};
  }
  if (!operationIds.create || !operationIds.count || !operationIds.delete || !transactionIdGenerator) {
    return {query, status: 'upstream_changed'};
  }

  const bearer = decodeURIComponent('AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA');

  async function requestJson(operationName, operationId, method, requestData, allowRetry = true) {
    const path = '/i/api/graphql/' + operationId + '/' + operationName;
    let url = path;
    if (method === 'GET') {
      url += '?variables=' + encodeURIComponent(JSON.stringify(requestData));
    }

    const maxAttempts = allowRetry ? 2 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let response;
      try {
        const transactionId = await transactionIdGenerator('x.com', path, method);
        const headers = {
          'Authorization': 'Bearer ' + bearer,
          'X-Csrf-Token': ct0,
          'X-Twitter-Auth-Type': 'OAuth2Session',
          'X-Twitter-Active-User': 'yes',
          'X-Client-Transaction-Id': transactionId,
          'Content-Type': 'application/json'
        };
        const options = {method, headers, credentials: 'include'};
        if (method === 'POST') options.body = JSON.stringify(requestData);
        response = await fetch(url, options);
      } catch {
        if (attempt + 1 < maxAttempts) continue;
        return {ok: false, status: 'network_error'};
      }

      if (!response.ok) {
        if (response.status >= 500 && attempt + 1 < maxAttempts) continue;
        return {ok: false, status: classifyHttpStatus(response.status)};
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        return {ok: false, status: 'upstream_changed'};
      }
      const relayFailure = classifyRelayFailure(payload);
      if (relayFailure) return {ok: false, status: relayFailure};
      return {ok: true, payload};
    }
    return {ok: false, status: 'network_error'};
  }

  const nowMs = Date.now();
  const now = new Date(nowMs);
  const utcTodayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const fromSeconds = Math.floor(utcTodayStartMs / 1000) - 6 * 86400;
  const toSeconds = Math.floor(nowMs / 1000);
  const countWindow = {
    from: new Date(fromSeconds * 1000).toISOString(),
    to: new Date(nowMs).toISOString(),
    timezone: 'UTC'
  };

  const createBody = {
    variables: {
      tags: null,
      title: 'CashMaker temporary ' + nowMs + '-' + Math.random().toString(36).slice(2, 10),
      advanced_query: query,
      notifications_enabled: false
    },
    queryId: operationIds.create
  };
  const createResult = await requestJson(
    'createInsightInputMutation',
    operationIds.create,
    'POST',
    createBody,
    false
  );
  if (!createResult.ok) return {query, status: createResult.status};

  const temporaryRuleId = createResult.payload?.data?.create_insight_rule_v2?.result?.rest_id;
  if (!temporaryRuleId) return {query, status: 'upstream_changed'};

  let outcome = {query, status: 'upstream_changed'};
  let cleanupFailed = false;
  try {
    const countVariables = {
      from_time: fromSeconds,
      to_time: toSeconds,
      granularity: 'Day',
      id: temporaryRuleId,
      timezone_offset: 0
    };
    const deadlineMs = Date.now() + 15000;

    while (true) {
      const countResult = await requestJson(
        'usePostCountQuery',
        operationIds.count,
        'GET',
        countVariables
      );
      if (!countResult.ok) {
        outcome = {query, status: countResult.status};
        break;
      }

      const matchedPostCounts = countResult.payload?.data?.viewer_v2?.user_results?.result?.insight_rule_by_id?.matched_post_counts;
      let countBuckets = null;
      let sourceTotal = null;
      if (Array.isArray(matchedPostCounts)) {
        countBuckets = matchedPostCounts;
      } else if (matchedPostCounts && typeof matchedPostCounts === 'object') {
        if (Array.isArray(matchedPostCounts.counts)) {
          countBuckets = matchedPostCounts.counts;
          sourceTotal = matchedPostCounts.total;
        } else if (String(matchedPostCounts.__typename || '').includes('Failure')) {
          outcome = {
            query,
            status: classifyRelayFailure({errors: [matchedPostCounts]}) || 'upstream_changed'
          };
          break;
        }
      } else if (matchedPostCounts !== null && matchedPostCounts !== undefined) {
        outcome = {query, status: 'upstream_changed'};
        break;
      }
      if (Array.isArray(countBuckets)) {
        const normalized = normalizeCounts(countBuckets, utcTodayStartMs, sourceTotal);
        if (normalized.usable) {
          outcome = {
            query,
            observed_at: new Date(nowMs).toISOString(),
            window: countWindow,
            total_posts: normalized.total_posts,
            daily_counts: normalized.daily_counts,
            status: 'ok'
          };
          break;
        }
      }

      if (Date.now() >= deadlineMs) {
        outcome = {query, status: 'count_not_ready'};
        break;
      }
      await delay(Math.min(1000, deadlineMs - Date.now()));
    }
  } catch {
    outcome = {query, status: 'upstream_changed'};
  } finally {
    const deleteBody = {
      variables: {id: temporaryRuleId},
      queryId: operationIds.delete
    };
    const deleteResult = await requestJson(
      'deleteInsightButtonMutation',
      operationIds.delete,
      'POST',
      deleteBody
    );
    const deletedRuleId = deleteResult.ok
      ? deleteResult.payload?.data?.delete_insight_rule_v2?.result?.rest_id
      : null;
    cleanupFailed = !deleteResult.ok || deletedRuleId !== temporaryRuleId;
  }

  if (cleanupFailed) {
    return {
      status: 'cleanup_required',
      cleanup_status: 'failed',
      temporary_rule_id: temporaryRuleId,
      temporary_query: query,
      cause_status: outcome.status
    };
  }
  return {...outcome, cleanup_status: 'deleted'};
}
