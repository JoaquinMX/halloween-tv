plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.joaquinmx.tv_app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_11.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.joaquinmx.tv_app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        create("release") {
            // Q4-signing (done): party keystore, driven ENTIRELY by env vars — no secrets in this file.
            // Passwords live only in a local secure note outside the repo; never commit them.
            storeFile = file(System.getenv("KEYSTORE_PATH") ?: "../../../../halloween-party.jks")
            storePassword = System.getenv("KEYSTORE_PASSWORD")
            keyAlias = System.getenv("KEY_ALIAS")
            keyPassword = System.getenv("KEY_PASSWORD")
        }
    }

    buildTypes {
        release {
            // TODO (Q4-signing, updated): party `release` signingConfig above is wired when env vars resolve AND the keystore file exists; otherwise falls back to debug signing so `flutter run --release` and debug builds keep working. What remains: owner keeps passwords in secure note; rotation = new keystore = reinstall (see docs/RELEASE-SIGNING.md).
            val keystoreFile = file(System.getenv("KEYSTORE_PATH") ?: "../../../../halloween-party.jks")
            val hasReleaseKeys = System.getenv("KEYSTORE_PASSWORD") != null
                && System.getenv("KEY_ALIAS") != null
                && System.getenv("KEY_PASSWORD") != null
                && keystoreFile.exists()
            signingConfig = if (hasReleaseKeys) {
                signingConfigs.getByName("release")
            } else {
                logger.warn("WARNING: release signing env vars (KEYSTORE_PATH, KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD) not fully set or keystore file missing at ${keystoreFile} — falling back to debug signing. Release APK will NOT be party-signed.")
                signingConfigs.getByName("debug")
            }
        }
    }
}

flutter {
    source = "../.."
}
