import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// KNOX release signing: persistent self-signed key so that v1.0.8, v1.0.9…
// all share ONE signature. Changing signatures between updates is the #1
// cause of "App not installed as package appears to be invalid"
// (INSTALL_FAILED_UPDATE_INCOMPATIBLE). Debug keystores are per-machine and
// get regenerated, so we never ship those for release.
// Secrets live in ../key.properties (gitignored) or env vars:
//   KNOX_STORE_FILE / KNOX_STORE_PASSWORD / KNOX_KEY_ALIAS / KNOX_KEY_PASSWORD
val keystoreProperties = Properties().apply {
    val candidates = listOf(
        file("../key.properties"),
        file("key.properties")
    )
    for (f in candidates) {
        if (f.exists()) {
            f.inputStream().use { load(it) }
            break
        }
    }
}
val knoxStoreFileProp =
    keystoreProperties.getProperty("storeFile")
        ?: System.getenv("KNOX_STORE_FILE")
val knoxStorePasswordProp =
    keystoreProperties.getProperty("storePassword")
        ?: System.getenv("KNOX_STORE_PASSWORD")
val knoxKeyAliasProp =
    keystoreProperties.getProperty("keyAlias")
        ?: System.getenv("KNOX_KEY_ALIAS")
val knoxKeyPasswordProp =
    keystoreProperties.getProperty("keyPassword")
        ?: System.getenv("KNOX_KEY_PASSWORD")
fun resolveKnoxStoreFile(): java.io.File? {
    if (knoxStoreFileProp.isNullOrBlank()) return null
    val direct = file(knoxStoreFileProp)
    if (direct.exists()) return direct
    val parentRelative = file("../${knoxStoreFileProp}")
    if (parentRelative.exists()) return parentRelative
    return direct
}
val knoxHasReleaseKey =
    !knoxStoreFileProp.isNullOrBlank()
        && !knoxStorePasswordProp.isNullOrBlank()
        && !knoxKeyAliasProp.isNullOrBlank()
        && !knoxKeyPasswordProp.isNullOrBlank()
        && resolveKnoxStoreFile()?.exists() == true

android {
    compileSdk = 36
    namespace = "com.knox.music"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.knox.music"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        create("knoxRelease") {
            if (knoxHasReleaseKey) {
                storeFile = resolveKnoxStoreFile()
                storePassword = knoxStorePasswordProp
                keyAlias = knoxKeyAliasProp
                keyPassword = knoxKeyPasswordProp
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            // NOTE: v1 (JAR) + v2 signing are enabled on the knoxRelease
            // signingConfig below (AGP also enables both by default for any
            // release signing config). Both schemes ON maximises
            // PackageInstaller compatibility ("package appears invalid"
            // happens on some devices with v2/v3-only APKs).
            if (knoxHasReleaseKey) {
                signingConfig = signingConfigs.getByName("knoxRelease")
            }
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")

tasks.register("patchRustWebView") {
    outputs.upToDateWhen { false }
    doLast {
        val rustWebViewFile = file("src/main/java/com/knox/music/generated/RustWebView.kt")
        if (rustWebViewFile.exists()) {
            var code = rustWebViewFile.readText()
            if (!code.contains("override fun onPause()")) {
                val lastBrace = code.lastIndexOf('}')
                if (lastBrace != -1) {
                    val overrides = """    override fun onPause() {
        // Knox: Do not pause WebView in background so audio playback and timers continue
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(android.view.View.VISIBLE)
    }

    override fun dispatchWindowVisibilityChanged(visibility: Int) {
        super.dispatchWindowVisibilityChanged(android.view.View.VISIBLE)
    }
}
"""
                    code = code.substring(0, lastBrace) + overrides
                    rustWebViewFile.writeText(code)
                    println("Knox: successfully patched RustWebView.kt with background continuity overrides")
                }
            }
        }
    }
}

tasks.matching { it.name.startsWith("compile") && it.name.contains("Kotlin") }.configureEach {
    dependsOn("patchRustWebView")
}

tasks.named("preBuild").configure {
    dependsOn("patchRustWebView")
}