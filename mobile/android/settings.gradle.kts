pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    // AGP 9's compileOptions requests a real Gradle Java toolchain (JDK 17)
    // rather than just a javac -source/-target flag. This machine only has
    // JDK 25 installed, so let Gradle auto-download a matching JDK 17
    // instead of pinning the whole build to whatever JDK happens to be on
    // the host.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "kobolink-android"
include(":app")
