// Phone half of Quiet Face Swap. The watch reports whether Quiet Time is active, and this code
// turns it the other way and launches the face chosen for the new state.
//
// Launching a face closes the watch app, which stops this script, so nothing can run after that
// launch completes. That decides the order below.

var Clay = require('@rebble/clay');
var clayConfig = require('./config');
var clayPage = require('./config-page');
var searchStores = require('./store-search');
var sun = require('./sun');

// The faces are only used on the phone, so these events are handled here to stop Clay sending
// them to the watch. Clay still stores them in localStorage.
var clay = new Clay(clayConfig, clayPage, { autoHandleEvents: false });

var WATCH_SETTINGS_PLUGIN = '00000000-0000-0000-0001-000000000006';
var WATCH_STATE_PLUGIN = '00000000-0000-0000-0001-000000000007';
var QUIET_TIME_TOGGLE_APP = '2220d805-cf9a-4e12-92b9-5ca778aff6bb';
var MANUAL_QUIET_TIME_SETTING = 'dndManuallyEnabled';

var SETTING_READ_TIMEOUT_MS = 3000;
var FACE_LAUNCH_TIMEOUT_MS = 4000;
var MAX_FACE_LAUNCH_ATTEMPTS = 7;

var LOCATION_TIMEOUT_MS = 5000;
var LOCATION_MAX_AGE_MS = 3600000;

var CLAY_SETTINGS_KEY = 'clay-settings';
var LAST_LOCATION_KEY = 'last-location';

// Must match AutoSwapMode in src/shared/state.h.
var AUTO_SWAP = { OFF: 0, QUIET_TIME: 1, SUN: 2, SUN_ONLY: 3 };

// Must match Status in src/c/main.c.
var STATUS = {
  NOT_CONFIGURED: 1,
  PERMISSION_DENIED: 2,
  FAILED: 3,
  SAVED: 4,
  SWAP_AFTER_TOGGLE: 5,
  FACES_CHANGED: 6,
  LOADING_FACE: 7,
  NO_LOCATION: 8,
};

var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function savedSettings() {
  try {
    return JSON.parse(localStorage.getItem(CLAY_SETTINGS_KEY)) || {};
  } catch (e) {
    console.log('could not read settings: ' + e);
    return {};
  }
}

// The settings page saves each face as "uuid|title", so it can show the title when reopened.
function uuidOf(choice) {
  return String(choice || '').split('|')[0];
}

function savedFaces() {
  var settings = savedSettings();
  return { quiet: uuidOf(settings.quietFace), normal: uuidOf(settings.normalFace) };
}

function facesAreValid(faces) {
  return UUID_PATTERN.test(faces.quiet) && UUID_PATTERN.test(faces.normal);
}

// Earlier versions saved this as true or false.
function autoSwapMode() {
  var saved = savedSettings().autoSwap;
  if (saved === false) {
    return AUTO_SWAP.OFF;
  }
  var mode = parseInt(saved, 10);
  return isNaN(mode) ? AUTO_SWAP.QUIET_TIME : mode;
}

function report(status) {
  Pebble.sendAppMessage({ status: status }, function () {}, function () {});
}

function invoke(plugin, action, args, timeoutMs) {
  return Pebble.invokeAction({ plugin: plugin, action: action, args: args, timeoutMs: timeoutMs })
    .then(function (result) {
      if (!result.ok) {
        var error = new Error(result.message || action + ' failed');
        error.code = result.code;
        throw error;
      }
      return result;
    });
}

function launch(uuid) {
  return invoke(WATCH_STATE_PLUGIN, 'launch_app', { uuid: uuid });
}

// A face in the locker may not be on the watch yet. The watch ignores a launch for a face it
// doesn't have and the phone never answers, but the attempt marks the face as active, which can
// get it synced. So this keeps asking until the face runs, which closes this app.
function launchFace(uuid, attempt) {
  var thisAttempt = attempt || 1;
  return invoke(WATCH_STATE_PLUGIN, 'launch_app', { uuid: uuid }, FACE_LAUNCH_TIMEOUT_MS)
    .catch(function (error) {
      if (error.code !== 'TIMEOUT' || thisAttempt >= MAX_FACE_LAUNCH_ATTEMPTS) {
        throw error;
      }
      if (thisAttempt === 1) {
        report(STATUS.LOADING_FACE);
      }
      return launchFace(uuid, thisAttempt + 1);
    });
}

function fail(error) {
  console.log('swap failed: ' + error.code + ' ' + error.message);
  report(error.code === 'PERMISSION_DENIED' ? STATUS.PERMISSION_DENIED : STATUS.FAILED);
}

function setManualQuietTimeThenLaunch(on, face) {
  invoke(WATCH_SETTINGS_PLUGIN, 'set_on', { instanceId: MANUAL_QUIET_TIME_SETTING, on: on })
    .then(function () { return launchFace(face); })
    .catch(fail);
}

// Answers with whether Quiet Time was started by hand. If the setting can't be read it assumes
// so, because that path is the more reliable one.
function readManualQuietTime(callback) {
  var answered = false;
  var subscription = null;

  function answer(manual) {
    if (answered) {
      return;
    }
    answered = true;
    if (subscription) {
      subscription.unsubscribe();
    }
    callback(manual);
  }

  subscription = Pebble.subscribeToSource({
    plugin: WATCH_SETTINGS_PLUGIN,
    category: 'watch',
    item: 'switch_setting',
    onData: function (envelope) {
      var setting = ((envelope && envelope.instances) || []).filter(function (instance) {
        return instance.instanceId === MANUAL_QUIET_TIME_SETTING;
      })[0];
      var value = setting && setting.properties && setting.properties.value;
      answer(!value || !value.boolean || value.boolean.value);
    },
    onError: function () { answer(true); },
  });
  setTimeout(function () { answer(true); }, SETTING_READ_TIMEOUT_MS);
}

function followsSun(mode) {
  return mode === AUTO_SWAP.SUN || mode === AUTO_SWAP.SUN_ONLY;
}

// Only the watch's own toggle can end Quiet Time started by a schedule or calendar event, or change
// Quiet Time on older firmware. It closes this app, so the watch first schedules a wakeup to come
// back and swap the face.
function toggleThenSwapFace() {
  function launchToggle() {
    launch(QUIET_TIME_TOGGLE_APP).catch(fail);
  }
  Pebble.sendAppMessage({ status: STATUS.SWAP_AFTER_TOGGLE }, launchToggle, launchToggle);
}

function swap(quietActive, useToggle) {
  // Faces ignore Quiet Time in this mode, so the button is just the watch's own toggle.
  if (autoSwapMode() === AUTO_SWAP.SUN_ONLY) {
    launch(QUIET_TIME_TOGGLE_APP).catch(fail);
    return;
  }

  var faces = savedFaces();
  if (!facesAreValid(faces)) {
    report(STATUS.NOT_CONFIGURED);
    return;
  }

  if (useToggle) {
    toggleThenSwapFace();
    return;
  }

  if (!quietActive) {
    setManualQuietTimeThenLaunch(true, faces.quiet);
    return;
  }

  readManualQuietTime(function (manual) {
    if (manual) {
      setManualQuietTimeThenLaunch(false, faces.normal);
      return;
    }
    toggleThenSwapFace();
  });
}

function lastLocation() {
  try {
    return JSON.parse(localStorage.getItem(LAST_LOCATION_KEY));
  } catch (e) {
    return null;
  }
}

// Answers with the phone's location, or the last one known if it can't get a new one. The app
// only uses this on the phone, to work out sunrise and sunset.
function findLocation(callback) {
  var answered = false;

  function answer(location) {
    if (!answered) {
      answered = true;
      callback(location);
    }
  }

  navigator.geolocation.getCurrentPosition(function (position) {
    var location = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    };
    localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify(location));
    answer(location);
  }, function () {
    answer(lastLocation());
  }, { timeout: LOCATION_TIMEOUT_MS, maximumAge: LOCATION_MAX_AGE_MS });

  setTimeout(function () { answer(lastLocation()); }, LOCATION_TIMEOUT_MS + 1000);
}

// Sends the watch the next sunrise or sunset first, because the face launch closes the app.
function syncFaceToSun() {
  var faces = savedFaces();
  if (!facesAreValid(faces)) {
    report(STATUS.NOT_CONFIGURED);
    return;
  }

  findLocation(function (location) {
    if (!location) {
      report(STATUS.NO_LOCATION);
      return;
    }
    var now = Date.now();
    var night = sun.isNight(now, location.latitude, location.longitude);
    var nextChange = sun.nextChange(now, location.latitude, location.longitude);

    function launchChosenFace() {
      launchFace(night ? faces.quiet : faces.normal).catch(fail);
    }
    Pebble.sendAppMessage({ nextSunChange: Math.ceil(nextChange / 1000) },
      launchChosenFace, launchChosenFace);
  });
}

// Quiet Time changed some other way, so only the face needs to follow it.
function syncFace(quietActive) {
  var faces = savedFaces();
  if (!facesAreValid(faces)) {
    report(STATUS.NOT_CONFIGURED);
    return;
  }
  launchFace(quietActive ? faces.quiet : faces.normal).catch(fail);
}

Pebble.addEventListener('ready', function () {
  Pebble.sendAppMessage({ ready: 1, autoSwap: autoSwapMode() }, function () {}, function () {
    console.log('could not reach the watch app');
  });
});

Pebble.addEventListener('appmessage', function (e) {
  if (e.payload.quietActive !== undefined) {
    swap(!!e.payload.quietActive, !!e.payload.useToggle);
  } else if (e.payload.syncQuiet !== undefined) {
    syncFace(!!e.payload.syncQuiet);
  } else if (e.payload.syncSun !== undefined) {
    syncFaceToSun();
  }
});

Pebble.addEventListener('showConfiguration', function () {
  var settings = savedSettings();
  clay.setSettings('autoSwap', String(autoSwapMode()));
  clay.meta.userData = { quietFace: settings.quietFace || '', normalFace: settings.normalFace || '' };
  Pebble.openURL(clay.generateUrl());
});

function watchPlatform() {
  var watch = Pebble.getActiveWatchInfo && Pebble.getActiveWatchInfo();
  return (watch && watch.platform) || '';
}

Pebble.addEventListener('configmessage', function (e) {
  if (e.data && e.data.type === 'search') {
    searchStores(String(e.data.query || ''), watchPlatform(), e.respond);
  }
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) {
    return;
  }
  var before = savedFaces();
  var modeBefore = autoSwapMode();
  clay.getSettings(e.response, false);
  var after = savedFaces();
  var mode = autoSwapMode();
  var changed = before.quiet !== after.quiet || before.normal !== after.normal ||
    (followsSun(mode) && !followsSun(modeBefore));

  var status = STATUS.NOT_CONFIGURED;
  if (facesAreValid(after)) {
    status = changed ? STATUS.FACES_CHANGED : STATUS.SAVED;
  }
  Pebble.sendAppMessage({ status: status, autoSwap: mode },
    function () {}, function () {});
});
