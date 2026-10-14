# knox-media consumer rules: the plugin entry point, its @Command methods,
# @InvokeArg payloads, and the playback service are reached via Tauri's
# runtime reflection + manifest merge, so the app's minify step must keep
# them (and their annotations) verbatim.
-keep class com.knox.music.knoxmedia.** { *; }
-keepattributes *Annotation*
-keep @app.tauri.annotation.TauriPlugin class * { *; }
-keepclasseswithmembernames class * {
    @app.tauri.annotation.Command <methods>;
}
-keepclasseswithmembers class * {
    @app.tauri.annotation.InvokeArg <fields>;
}
