// Opens the app to swap the face, either when Quiet Time changes without a button press or at the
// next sunrise or sunset. The SDK has no Quiet Time event, so this checks once a minute.

#include <pebble_worker.h>
#include "../shared/state.h"

// pebble_worker.h leaves this out, but the worker SDK library exports it and the firmware doesn't
// restrict it to apps.
bool quiet_time_is_active(void);

#define MAX_ATTEMPTS 3

// The button records the new state before Quiet Time changes, so a check straight after a press
// could otherwise see them disagree.
#define BUTTON_SETTLE_SECONDS 20

static int s_attempts;
static bool s_last_seen_state;

static bool prv_recently_handled(void) {
  return time(NULL) - persist_read_int(PERSIST_KEY_HANDLED_AT) < BUTTON_SETTLE_SECONDS;
}

static void prv_try_launch(void) {
  if (s_attempts >= MAX_ATTEMPTS || !connection_service_peek_pebble_app_connection()) {
    return;
  }
  s_attempts++;
  worker_launch_app();
}

static void prv_check_quiet_time(void) {
  const bool quiet_active = quiet_time_is_active();
  if (quiet_active != s_last_seen_state) {
    s_last_seen_state = quiet_active;
    s_attempts = 0;
  }

  if (quiet_active != persist_read_bool(PERSIST_KEY_HANDLED_STATE) && !prv_recently_handled()) {
    prv_try_launch();
  }
}

static void prv_check_sun(void) {
  const int32_t next_change = persist_read_int(PERSIST_KEY_NEXT_SUN_CHANGE);
  if (next_change != 0 && time(NULL) >= next_change) {
    prv_try_launch();
  } else {
    s_attempts = 0;
  }
}

static void prv_check(void) {
  // The app stops this worker when swaps go off, but a reboot can start it again.
  switch (auto_swap_mode()) {
    case AutoSwapQuietTime:
      prv_check_quiet_time();
      break;
    case AutoSwapSun:
    case AutoSwapSunOnly:
      prv_check_sun();
      break;
    default:
      break;
  }
}

static void prv_tick(struct tm *tick_time, TimeUnits units_changed) {
  prv_check();
}

static void prv_phone_connection(bool connected) {
  if (connected) {
    s_attempts = 0;
  }
}

static void prv_init(void) {
  s_last_seen_state = quiet_time_is_active();
  if (!persist_exists(PERSIST_KEY_HANDLED_STATE)) {
    persist_write_bool(PERSIST_KEY_HANDLED_STATE, s_last_seen_state);
  }
  connection_service_subscribe((ConnectionHandlers) {
    .pebble_app_connection_handler = prv_phone_connection,
  });
  tick_timer_service_subscribe(MINUTE_UNIT, prv_tick);
}

int main(void) {
  prv_init();
  worker_event_loop();
  tick_timer_service_unsubscribe();
  connection_service_unsubscribe();
}
