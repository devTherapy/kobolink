// Root build file. Plugins are declared here (with apply false) and applied
// per-module so version numbers live in exactly one place.
plugins {
    // AGP 9+ has Kotlin support built in, so there is no separate
    // `org.jetbrains.kotlin.android` plugin to declare here.
    id("com.android.application") version "9.3.2" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.2.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.21" apply false
    id("org.openapi.generator") version "7.14.0" apply false
}

tasks.register("clean", Delete::class) {
    delete(rootProject.layout.buildDirectory)
}
