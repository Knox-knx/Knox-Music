# KNOX Music — Linux desktop (Tauri/WebKitGTK) runtime

KNOX Music desktop keeps the existing Tauri + WebKitGTK architecture:
`App → playerStore → singleton AudioEngine → single HTMLAudioElement`.
No second audio element, no `<audio>` in JSX, no extra backend.

Audio playback in the Linux shell is decoded by **WebKitGTK → GStreamer**.
If GStreamer or its plugin sets are missing, WebKit logs errors such as:

```
GStreamer element appsink not found.
GStreamer element autoaudiosink not found.
```

KNOX does **not** hide this error. It means the OS media backend is
incomplete — not an app bug. Install the system GStreamer runtime below.

## Required runtime packages (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-0 \
  libgtk-3-0 \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly \
  gstreamer1.0-libav \
  gstreamer1.0-alsa \
  gstreamer1.0-pulseaudio
```

What each set covers:

| Package | Why |
|---|---|
| `libwebkit2gtk-4.1-0`, `libgtk-3-0` | Tauri window + renderer |
| `gstreamer1.0-plugins-base` | provides `appsink` (WebKit audio sink input) |
| `gstreamer1.0-plugins-good` | provides `autoaudiosink`, PulseAudio/ALSA routing |
| `gstreamer1.0-plugins-bad` | extra demuxers / containers |
| `gstreamer1.0-plugins-ugly` | MP3 (`mad`) decoding on many distros |
| `gstreamer1.0-libav` | broad ffmpeg-based fallback decoding |
| `gstreamer1.0-alsa`, `gstreamer1.0-pulseaudio` | actual audio output |

Fedora/openSUSE equivalents: `webkit2gtk4.1`, `gtk3`,
`gstreamer1-plugins-base`, `gstreamer1-plugins-good`,
`gstreamer1-plugins-bad-free`, `gstreamer1-plugins-ugly-free`,
`gstreamer1-libav`, `gstreamer1-plugins-pulseaudio` (RPM Fusion may be
needed for ugly/libav).

## Verify

```bash
# Plugins are discoverable:
gst-inspect-1.0 appsink | head -5
gst-inspect-1.0 autoaudiosink | head -5

# Launch with WebKit media logging if audio still fails:
WEBKIT_GST_DEBUG=3 ./KNOX*.AppImage
```

Then in-app: Search → play an AirBeats/Jamendo result → Now Playing
progress must advance and pause/play must work.

## Why not bundle GStreamer in the AppImage/.deb?

Bundling a full GStreamer runtime inside the AppImage is **unreliable with
WebKitGTK**:

- WebKitGTK discovers codecs via the system plugin scanner
  (`GST_PLUGIN_SYSTEM_PATH`, `gst-plugin-scanner`) and hardware paths;
  a bundled copy frequently fails codec discovery or loads mismatched
  system/user plugins.
- Audio output (`autoaudiosink` → PulseAudio/PipeWire/ALSA) must match the
  running session daemon; containerised plugins often cannot negotiate it.
- Bundling duplicates ~100–200 MB of codecs and still breaks on distros
  with different glibc/GStreamer ABIs.

So KNOX intentionally **does not bundle GStreamer**. The `.deb` declares
the packages above in `depends` (see `src-tauri/tauri.conf.json`); the
AppImage documents them here because AppImages cannot declare system
dependencies. Install the system packages once — all WebKitGTK apps benefit.

## Notes

- No architecture change: the fix is packaging/docs only.
- No cloud, no extra backend, no new provider.
- If `appsink`/`autoaudiosink` errors persist after installing, reboot or
  `rm -rf ~/.cache/gstreamer-1.0` to force a plugin rescan.
