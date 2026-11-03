# Quiet Face Swap

One Quick Launch press toggles Quiet Time and swaps between two watchfaces.

## Requirements

- Pebble mobile app 1.16 or later
- Plugins turned on: Settings → Plugins → Plugins / permissions preview
- A colour or black-and-white Pebble other than the original Pebble and Pebble Steel. On those
  watches the SDK always reports Quiet Time as off.

Plugins are in preview, so sideload this app. The docs ask developers not to publish
plugin-using apps to the app store yet.

## Build and install

```sh
pebble sdk install latest
python3 scripts/pack-plugin-pbw.py .
pebble install --cloudpebble build/quiet-face-swap.pbw
```

Use the script rather than plain `pebble build`. It marks the app as `manifestVersion: 2`. Without
that, the phone treats the app as legacy and refuses its plugin calls. The first build fetches
`@rebble/clay` from npm.

## Set up

1. Open the app's settings in the Pebble mobile app. Type a watchface's name in each box, pick
   it from the list and tap Save.
   Opening settings starts the app on the watch without swapping anything. Saving new faces
   switches straight away to the face for the current Quiet Time state.
2. On the phone, set a Quick Launch button to Quiet Face Swap.
3. Press the button and approve the permission prompts on the phone.

## Choosing faces

The mobile app doesn't let apps read the locker, so settings search the Core and Rebble app stores
instead. Results are limited to faces listed as compatible with the connected watch. They still
include faces the user hasn't installed, and sideloaded faces won't appear. A chosen face must be
in the locker for the swap to work. If it isn't on the watch yet, the app shows "Loading face..."
and retries for up to about 28 seconds while the phone syncs it.

To protect the stores, the settings page waits 800 ms after typing and needs 3 characters. The
phone script caches results, joins identical searches and allows 12 searches a minute. It backs off
a store for 30 seconds to 5 minutes after a failure. Each search asks each store for 20 results and
shows up to 15 after merging.

Search uses the same public search-only Algolia keys as the Pebble mobile app, listed in
`src/pkjs/store-search.js`. They appear in that app's open source code. If the stores change them,
update that file.

## How the toggle works

- **Turning on:** the phone sets `dndManuallyEnabled`, then launches the Quiet Time face.
- **Turning off, started by hand:** the phone clears `dndManuallyEnabled`, then launches the normal
  face.
- **Turning off, started by a schedule or calendar event:** the watch schedules a wakeup, then the
  phone launches the watch's built-in Quiet Time toggle, the only thing that can end this kind of
  Quiet Time. The toggle's dialog shows, then the wakeup reopens the app about 4 seconds later to
  swap the face. This works with or without the worker.

On Basalt, Chalk and Diorite, which stay on older firmware without settings sync, every button press
uses the built-in toggle and wakeup path, so the face changes about 4 seconds later.

## Automatic swaps

Settings offer four choices, and With Quiet Time is the default:

- **Off (button only):** only the button swaps faces, and the worker stops.
- **With Quiet Time:** the worker checks Quiet Time once a minute. If it changed without a button
  press, it opens the app, which swaps the face without touching Quiet Time.
- **Sunrise, sunset and button:** the night face is the Quiet Time on face, and the day face is the Quiet
  Time off face. The worker opens the app at the next change. The phone then gets its location,
  picks the face, and tells the watch when the following change is. The location stays on the phone
  and is reused if a new one isn't available. In this mode Quiet Time alone doesn't swap the face.
  The button works as usual, and its face stays until the next sunrise or sunset.
- **Sunrise and sunset only:** the same, except faces ignore Quiet Time completely. The button opens
  the watch's built-in Quiet Time toggle and doesn't change the face.

With either automatic choice, opening settings starts the worker, and the watch asks first if
another app's worker is running. A swap can interrupt whatever is on screen.

A watch runs one worker at a time. If another app takes over, open this app's settings to switch
back. The button still works without the worker.

If a swap fails, the worker tries up to 3 times, a minute apart, and starts again when the phone
reconnects.

A button press needs the phone. If it isn't connected, the app shows an error and nothing changes.
