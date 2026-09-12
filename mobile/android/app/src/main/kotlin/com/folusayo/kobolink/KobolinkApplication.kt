package com.folusayo.kobolink

import android.app.Application
import com.folusayo.kobolink.api.ApiClientProvider

/**
 * Registered in AndroidManifest.xml as the app's `<application android:name>`
 * so [ApiClientProvider.init] runs exactly once, before [MainActivity] (or
 * any future Activity) can touch the API client — see that object's doc
 * comment for why it needs a `Context` at all.
 */
class KobolinkApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        ApiClientProvider.init(applicationContext)
    }
}
