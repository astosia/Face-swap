// Put this app on a Quick Launch button. One press toggles Quiet Time and swaps the watchface.
//
// The watch only reports the current Quiet Time state. The phone does the work, because the SDK
// has no call to change Quiet Time or launch another app. On success the phone launches the
// target face, which closes this app.
//
// Opening settings on the phone also launches this app, so a phone launch must not swap.
//
// The background worker opens this app when Quiet Time changes some other way. That launch only
// matches the face to the current state and never toggles. In sunrise and sunset mode it opens
// this app at the next change, and the phone picks the face and sends the time of the one after.
//
// Ending Quiet Time started by a schedule or calendar event needs the watch's own toggle, which
// closes this app. So this app schedules a wakeup first, and comes back to swap the face.

#include <pebble.h>
#include "../shared/state.h"

#define PHONE_TIMEOUT_MS 8000
#define ERROR_DISPLAY_MS 2500

// Must be longer than the phone's retries, in src/pkjs/index.js.
#define FACE_SYNC_TIMEOUT_MS 35000

// Long enough for the Quiet Time toggle's result dialog to finish.
#define SWAP_AFTER_TOGGLE_S 4

// These watches stay on older firmware without settings sync, so the phone can't change Quiet Time
// by writing the setting. Their button uses the watch's own toggle instead.
#if defined(PBL_PLATFORM_BASALT) || defined(PBL_PLATFORM_CHALK) || defined(PBL_PLATFORM_DIORITE)
#define BUTTON_NEEDS_TOGGLE 1
#else
#define BUTTON_NEEDS_TOGGLE 0
#endif

// Must match STATUS in src/pkjs/index.js.
typedef enum {
  StatusNotConfigured = 1,
  StatusPermissionDenied = 2,
  StatusFailed = 3,
  StatusSaved = 4,
  StatusSwapAfterToggle = 5,
  StatusFacesChanged = 6,
  StatusLoadingFace = 7,
  StatusNoLocation = 8,
} Status;

static Window *s_window;
static TextLayer *s_text_layer;
static AppTimer *s_timer;

// What to record as handled if this swap doesn't finish, so the worker tries again.
static bool s_handled_if_failed;

// Whether a failed swap should make the worker try this sunrise or sunset again.
static bool s_retry_sun_change;

static void prv_exit(void *context) {
  s_timer = NULL;
  window_stack_pop_all(false);
}

static void prv_show_and_exit(const char *message) {
  text_layer_set_text(s_text_layer, message);
  if (s_timer) {
    app_timer_cancel(s_timer);
  }
  s_timer = app_timer_register(ERROR_DISPLAY_MS, prv_exit, NULL);
}

static void prv_record_handled(bool quiet_active) {
  persist_write_bool(PERSIST_KEY_HANDLED_STATE, quiet_active);
  persist_write_int(PERSIST_KEY_HANDLED_AT, (int32_t)time(NULL));
}

static void prv_fail(const char *message) {
  prv_record_handled(s_handled_if_failed);
  if (s_retry_sun_change) {
    persist_write_int(PERSIST_KEY_NEXT_SUN_CHANGE, (int32_t)time(NULL));
  }
  prv_show_and_exit(message);
}

static void prv_timeout(void *context) {
  s_timer = NULL;
  prv_fail("Phone didn't respond");
}

static bool prv_opened_for_settings(void) {
  return launch_reason() == APP_LAUNCH_PHONE;
}

static bool prv_only_syncing_face(void) {
  return launch_reason() == APP_LAUNCH_WORKER || launch_reason() == APP_LAUNCH_WAKEUP;
}

// In sunrise and sunset only mode the button just toggles Quiet Time, and the face only changes
// at sunrise, at sunset or after saving new faces, so each says what it's doing.
static const char *prv_busy_text(void) {
  if (auto_swap_mode() != AutoSwapSunOnly) {
    return "Switching...";
  }
  const bool button_press = !prv_only_syncing_face() && !prv_opened_for_settings();
  return button_press ? "Quiet Time switching..." : "Changing face...";
}

static void prv_send_state(bool sync_only, bool worker_should_retry) {
  const bool quiet_active = quiet_time_is_active();
  // A wakeup finishes a button press, so that face still follows Quiet Time.
  const bool follow_sun = sync_only && auto_swap_follows_sun(auto_swap_mode()) &&
                          launch_reason() != APP_LAUNCH_WAKEUP;
  s_retry_sun_change = follow_sun && worker_should_retry;

  // Recorded first, because a successful swap closes this app.
  s_handled_if_failed = worker_should_retry ? !quiet_active : quiet_active;
  prv_record_handled(sync_only ? quiet_active : !quiet_active);

  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    prv_fail("Couldn't reach phone");
    return;
  }
  const uint32_t key = follow_sun ? MESSAGE_KEY_syncSun :
                       sync_only ? MESSAGE_KEY_syncQuiet : MESSAGE_KEY_quietActive;
  dict_write_uint8(out, key, quiet_active ? 1 : 0);
  if (!sync_only) {
    dict_write_uint8(out, MESSAGE_KEY_useToggle, BUTTON_NEEDS_TOGGLE);
  }
  if (app_message_outbox_send() != APP_MSG_OK) {
    prv_fail("Couldn't reach phone");
  }
}

static void prv_apply_auto_swap(AutoSwapMode mode) {
  const bool changed = mode != auto_swap_mode();
  persist_write_int(PERSIST_KEY_AUTO_MODE, mode);

  if (mode == AutoSwapOff) {
    if (app_worker_is_running()) {
      app_worker_kill();
    }
  } else if ((changed || prv_opened_for_settings()) && !app_worker_is_running()) {
    // If another app's worker is running, the watch asks the user before replacing it.
    app_worker_launch();
  }
}

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *auto_swap = dict_find(iter, MESSAGE_KEY_autoSwap);
  if (auto_swap) {
    prv_apply_auto_swap((AutoSwapMode)auto_swap->value->uint8);
  }

  Tuple *next_sun_change = dict_find(iter, MESSAGE_KEY_nextSunChange);
  if (next_sun_change) {
    persist_write_int(PERSIST_KEY_NEXT_SUN_CHANGE, next_sun_change->value->int32);
    return;
  }

  if (dict_find(iter, MESSAGE_KEY_ready)) {
    if (!prv_opened_for_settings()) {
      const bool sync_only = prv_only_syncing_face();
      prv_send_state(sync_only, sync_only);
    }
    return;
  }

  Tuple *status = dict_find(iter, MESSAGE_KEY_status);
  if (!status) {
    return;
  }
  switch ((Status)status->value->int32) {
    case StatusNotConfigured:
      // Retrying can't help until settings change.
      prv_record_handled(quiet_time_is_active());
      prv_show_and_exit("Choose faces in the phone app");
      break;
    case StatusPermissionDenied:
      prv_fail("Allow access in the phone app");
      break;
    case StatusNoLocation:
      // Retrying can't help until the phone has a location, and saving settings sets this again.
      s_retry_sun_change = false;
      persist_write_int(PERSIST_KEY_NEXT_SUN_CHANGE, 0);
      prv_show_and_exit("Allow location in the phone app");
      break;
    case StatusSaved:
      prv_show_and_exit("Saved");
      break;
    case StatusLoadingFace:
      text_layer_set_text(s_text_layer, "Loading face...");
      if (s_timer) {
        app_timer_cancel(s_timer);
      }
      s_timer = app_timer_register(FACE_SYNC_TIMEOUT_MS, prv_timeout, NULL);
      break;
    case StatusFacesChanged:
      text_layer_set_text(s_text_layer, prv_busy_text());
      s_timer = app_timer_register(PHONE_TIMEOUT_MS, prv_timeout, NULL);
      prv_send_state(true, false);
      break;
    case StatusSwapAfterToggle:
      // Wakeups too close together are refused, so clear any left by an earlier press.
      wakeup_cancel_all();
      wakeup_schedule(time(NULL) + SWAP_AFTER_TOGGLE_S, 0, false);
      break;
    default:
      prv_fail("Swap failed");
      break;
  }
}

static void prv_outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  prv_fail("Couldn't reach phone");
}

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  GRect frame = GRect(bounds.origin.x + 8, bounds.size.h / 2 - 34, bounds.size.w - 16, 68);

  s_text_layer = text_layer_create(frame);
  text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_text_layer, GTextAlignmentCenter);
  text_layer_set_text(s_text_layer,
                      prv_opened_for_settings() ? "Settings open on phone" : prv_busy_text());
  layer_add_child(root, text_layer_get_layer(s_text_layer));
}

static void prv_window_unload(Window *window) {
  text_layer_destroy(s_text_layer);
}

static void prv_init(void) {
  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, false);

  if (!connection_service_peek_pebble_app_connection() && !prv_opened_for_settings()) {
    prv_show_and_exit("Phone not connected");
    return;
  }

  app_message_register_inbox_received(prv_inbox_received);
  app_message_register_outbox_failed(prv_outbox_failed);
  app_message_open(128, 64);

  if (prv_opened_for_settings()) {
    return;
  }

  // The phone sends `ready` when its JS starts, and the state goes back in reply.
  s_timer = app_timer_register(PHONE_TIMEOUT_MS, prv_timeout, NULL);
}

static void prv_deinit(void) {
  window_destroy(s_window);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
