// Works out day and night from the sun's position. Uses the height of the sun rather than
// sunrise formulas, so places where the sun doesn't rise or set need no special handling.

var RAD = Math.PI / 180;
var DAY_MS = 86400000;
var J2000_MS = Date.UTC(2000, 0, 1, 12);

// The sun counts as down once its top edge passes the horizon, allowing for refraction.
var HORIZON_DEGREES = -0.833;

var SEARCH_STEP_MS = 600000;
var SEARCH_RANGE_MS = 2 * DAY_MS;
var ACCURACY_MS = 30000;

function sunAltitudeDegrees(timeMs, latitude, longitude) {
  var days = (timeMs - J2000_MS) / DAY_MS;
  var meanAnomaly = (357.5291 + 0.98560028 * days) * RAD;
  var eclipticLongitude = meanAnomaly +
    (1.9148 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * RAD +
    (102.9372 + 180) * RAD;
  var tilt = 23.4397 * RAD;
  var declination = Math.asin(Math.sin(tilt) * Math.sin(eclipticLongitude));
  var rightAscension = Math.atan2(Math.sin(eclipticLongitude) * Math.cos(tilt),
    Math.cos(eclipticLongitude));
  var siderealTime = (280.1470 + 360.9856235 * days + longitude) * RAD;
  var hourAngle = siderealTime - rightAscension;
  var phi = latitude * RAD;
  return Math.asin(Math.sin(phi) * Math.sin(declination) +
    Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle)) / RAD;
}

function isNight(timeMs, latitude, longitude) {
  return sunAltitudeDegrees(timeMs, latitude, longitude) < HORIZON_DEGREES;
}

// Time of the next sunrise or sunset. With neither in the next two days, it returns the end of
// that search, so the location gets checked again then.
function nextChange(timeMs, latitude, longitude) {
  var night = isNight(timeMs, latitude, longitude);
  var before = timeMs;

  for (var after = timeMs + SEARCH_STEP_MS; after <= timeMs + SEARCH_RANGE_MS;
    after += SEARCH_STEP_MS) {
    if (isNight(after, latitude, longitude) !== night) {
      while (after - before > ACCURACY_MS) {
        var middle = (before + after) / 2;
        if (isNight(middle, latitude, longitude) === night) {
          before = middle;
        } else {
          after = middle;
        }
      }
      return after;
    }
    before = after;
  }
  return timeMs + SEARCH_RANGE_MS;
}

module.exports = { isNight: isNight, nextChange: nextChange };
