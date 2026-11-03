#pragma once

// Used by both the app and the worker, which share persistent storage.
#define PERSIST_KEY_HANDLED_STATE 1
#define PERSIST_KEY_HANDLED_AT 2
#define PERSIST_KEY_AUTO_MODE 4
#define PERSIST_KEY_NEXT_SUN_CHANGE 5

// Must match AUTO_SWAP in src/pkjs/index.js.
typedef enum {
  AutoSwapOff = 0,
  AutoSwapQuietTime = 1,
  AutoSwapSun = 2,
  AutoSwapSunOnly = 3,
} AutoSwapMode;

static inline AutoSwapMode auto_swap_mode(void) {
  return persist_exists(PERSIST_KEY_AUTO_MODE) ? (AutoSwapMode)persist_read_int(PERSIST_KEY_AUTO_MODE)
                                               : AutoSwapQuietTime;
}

static inline bool auto_swap_follows_sun(AutoSwapMode mode) {
  return mode == AutoSwapSun || mode == AutoSwapSunOnly;
}
