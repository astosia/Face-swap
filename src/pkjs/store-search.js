// Searches the Core and Rebble app stores for watchfaces, by name.

var STORES = [
  {
    name: 'Core',
    appId: 'GM3S9TRYO4',
    apiKey: '0b83b4f8e4e8e9793d2f1f93c21894aa',
    index: 'apps',
  },
  {
    name: 'Rebble',
    appId: '7683OW76EQ',
    apiKey: '252f4938082b8693a8a9fc0157d1d24f',
    index: 'rebble-appstore-production',
  },
];

// More than are shown, because some are removed as incompatible with the watch.
var RESULTS_PER_STORE = 20;
var MAX_RESULTS_SHOWN = 15;
var MAX_QUERY_LENGTH = 64;
var REQUEST_TIMEOUT_MS = 10000;
var MAX_SEARCHES_PER_MINUTE = 12;
var MAX_CACHED_QUERIES = 50;
var FIRST_BACKOFF_MS = 30000;
var MAX_BACKOFF_MS = 300000;
var MINUTE_MS = 60000;

// The app builds each watch can run, matching the Pebble mobile app.
var COMPATIBLE_BUILDS = {
  basalt: ['basalt', 'aplite'],
  chalk: ['chalk'],
  diorite: ['diorite', 'aplite'],
  emery: ['emery', 'basalt', 'diorite', 'aplite'],
  flint: ['flint', 'diorite', 'aplite'],
  gabbro: ['gabbro', 'chalk'],
};

// These last until the phone script restarts, which is enough for one settings session.
var cache = {};
var cachedQueries = 0;
var searchesInProgress = {};
var recentSearchTimes = [];

function isBackingOff(store) {
  return Date.now() < (store.retryAt || 0);
}

function recordSuccess(store) {
  store.backoffMs = 0;
  store.retryAt = 0;
}

function recordFailure(store) {
  store.backoffMs = Math.min((store.backoffMs || FIRST_BACKOFF_MS / 2) * 2, MAX_BACKOFF_MS);
  store.retryAt = Date.now() + store.backoffMs;
}

function searchStore(store, query, done) {
  if (isBackingOff(store)) {
    done(null);
    return;
  }

  var host = store.appId.toLowerCase() + '-dsn.algolia.net';
  var request = new XMLHttpRequest();
  var finished = false;

  function finish(hits) {
    if (finished) {
      return;
    }
    finished = true;
    if (hits) {
      recordSuccess(store);
    } else {
      recordFailure(store);
    }
    done(hits);
  }

  request.open('POST', 'https://' + host + '/1/indexes/' + store.index + '/query');
  request.timeout = REQUEST_TIMEOUT_MS;
  request.setRequestHeader('X-Algolia-Application-Id', store.appId);
  request.setRequestHeader('X-Algolia-API-Key', store.apiKey);
  request.setRequestHeader('Content-Type', 'application/json');
  request.onload = function () {
    var hits = null;
    try {
      hits = request.status === 200 ? JSON.parse(request.responseText).hits : null;
    } catch (e) {
      console.log(store.name + ' store sent an unreadable reply');
    }
    finish(hits || null);
  };
  request.onerror = function () { finish(null); };
  request.ontimeout = function () { finish(null); };
  request.send(JSON.stringify({
    query: query,
    tagFilters: ['watchface'],
    hitsPerPage: RESULTS_PER_STORE,
    attributesToRetrieve: ['uuid', 'title', 'author', 'compatibility'],
    attributesToHighlight: [],
  }));
}

// A face is only hidden when its listing says it can't run. Unknown watches and listings without
// compatibility details keep it.
function runsOn(platform, hit) {
  var builds = COMPATIBLE_BUILDS[platform];
  if (!builds || !hit.compatibility) {
    return true;
  }
  return builds.some(function (build) {
    var details = hit.compatibility[build];
    return details && details.supported;
  });
}

// Both stores carry many of the same faces, so each UUID appears once.
function merge(hitLists, platform) {
  var seen = {};
  var results = [];
  hitLists.forEach(function (hits) {
    (hits || []).forEach(function (hit) {
      var uuid = String(hit.uuid || '').toLowerCase();
      if (uuid && hit.title && !seen[uuid] && runsOn(platform, hit)) {
        seen[uuid] = true;
        results.push({ uuid: uuid, title: hit.title, author: hit.author || '' });
      }
    });
  });
  return results.slice(0, MAX_RESULTS_SHOWN);
}

function underSearchLimit() {
  var now = Date.now();
  recentSearchTimes = recentSearchTimes.filter(function (time) {
    return now - time < MINUTE_MS;
  });
  return recentSearchTimes.length < MAX_SEARCHES_PER_MINUTE;
}

function remember(key, reply) {
  if (reply.failed) {
    return;
  }
  if (cachedQueries >= MAX_CACHED_QUERIES) {
    cache = {};
    cachedQueries = 0;
  }
  cache[key] = reply;
  cachedQueries += 1;
}

// Calls `respond` once with `{ results, failed, limited }`. `failed` counts the stores with no
// answer, and `limited` means the search was refused to protect the stores.
module.exports = function searchStores(query, platform, respond) {
  var text = query.trim().slice(0, MAX_QUERY_LENGTH);
  var key = platform + '|' + text.toLowerCase();

  if (cache[key]) {
    respond(cache[key]);
    return;
  }
  if (searchesInProgress[key]) {
    searchesInProgress[key].push(respond);
    return;
  }
  if (!underSearchLimit()) {
    respond({ results: [], failed: 0, limited: true });
    return;
  }

  recentSearchTimes.push(Date.now());
  searchesInProgress[key] = [respond];

  var hitLists = [];
  var pending = STORES.length;
  STORES.forEach(function (store, position) {
    searchStore(store, text, function (hits) {
      hitLists[position] = hits;
      pending -= 1;
      if (pending > 0) {
        return;
      }
      var reply = {
        results: merge(hitLists, platform),
        failed: hitLists.filter(function (list) { return !list; }).length,
      };
      var waiting = searchesInProgress[key];
      delete searchesInProgress[key];
      remember(key, reply);
      waiting.forEach(function (send) { send(reply); });
    });
  });
};
