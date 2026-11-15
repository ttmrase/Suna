package io.github.ttmrase.suna

import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import java.io.ByteArrayInputStream
import java.io.IOException
import java.util.Locale

/**
 * The whole game is the web page in assets/www, drawn full screen in a WebView.
 * This activity only serves those files to the page, keeps the system bars
 * out of the way and tells the page where the display cutout is.
 */
class MainActivity : Activity() {

    private var web: WebView? = null
    private var lastBack = 0L
    private var backCallback: OnBackInvokedCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // draw under the camera cutout; the page keeps its buttons clear of it
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val callback = OnBackInvokedCallback { handleBack() }
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
            backCallback = callback
        }
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            // debug builds can be inspected from chrome://inspect
            WebView.setWebContentsDebuggingEnabled(true)
        }
        hideSystemBars() // before the first layout, so the page starts at its final size
        createWebView()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        val view = WebView(this)
        view.setBackgroundColor(getColor(R.color.sand))
        view.overScrollMode = View.OVER_SCROLL_NEVER
        view.isVerticalScrollBarEnabled = false
        view.isHorizontalScrollBarEnabled = false
        view.isLongClickable = false
        view.isHapticFeedbackEnabled = false
        view.setOnLongClickListener { true }
        view.settings.apply {
            javaScriptEnabled = true          // the page is the app's own bundled code
            domStorageEnabled = true          // the beach is saved in localStorage
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        view.webViewClient = AssetClient()
        view.setOnApplyWindowInsetsListener { v, insets ->
            pushInsets(insets)
            v.onApplyWindowInsets(insets)
        }
        setContentView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        web = view
        view.loadUrl(START_URL)
    }

    /** Hide the status and navigation bars; a swipe from the edge shows them briefly. */
    private fun hideSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                it.hide(WindowInsets.Type.systemBars())
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN)
        }
    }

    /** Tell the page how far the cutout and any visible system bars reach in, in CSS pixels. */
    private fun pushInsets(insets: WindowInsets?) {
        val view = web ?: return
        val source = insets ?: view.rootWindowInsets ?: return
        var left = 0
        var top = 0
        var right = 0
        var bottom = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val i = source.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            left = i.left; top = i.top; right = i.right; bottom = i.bottom
        } else {
            @Suppress("DEPRECATION")
            run {
                left = source.systemWindowInsetLeft; top = source.systemWindowInsetTop
                right = source.systemWindowInsetRight; bottom = source.systemWindowInsetBottom
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                source.displayCutout?.let {
                    left = maxOf(left, it.safeInsetLeft); top = maxOf(top, it.safeInsetTop)
                    right = maxOf(right, it.safeInsetRight); bottom = maxOf(bottom, it.safeInsetBottom)
                }
            }
        }
        val density = resources.displayMetrics.density
        val js = String.format(
            Locale.US,
            "(function(s){s.setProperty('--safe-top','%.1fpx');s.setProperty('--safe-right','%.1fpx');" +
                "s.setProperty('--safe-bottom','%.1fpx');s.setProperty('--safe-left','%.1fpx');})(document.documentElement.style)",
            top / density, right / density, bottom / density, left / density,
        )
        view.evaluateJavascript(js, null)
    }

    private fun handleBack() {
        val view = web
        if (view == null) {
            leave()
            return
        }
        // the page closes its menu if one is open and reports whether it did
        view.evaluateJavascript("(window.suna&&window.suna.back)?window.suna.back():false") { handled ->
            if (handled == "true") return@evaluateJavascript
            val now = SystemClock.uptimeMillis()
            if (now - lastBack < 2500) {
                leave()
            } else {
                lastBack = now
                Toast.makeText(this, R.string.back_again, Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun leave() {
        moveTaskToBack(true)
    }

    @Deprecated("Used before Android 13; newer versions go through OnBackInvokedCallback")
    override fun onBackPressed() {
        handleBack()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        web?.onResume()
        web?.resumeTimers()
    }

    override fun onPause() {
        // ask the page to save the beach before its timers stop
        web?.evaluateJavascript("window.suna&&window.suna.save&&window.suna.save()", null)
        web?.onPause()
        web?.pauseTimers()
        super.onPause()
    }

    override fun onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            backCallback?.let { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it) }
        }
        web?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        web = null
        super.onDestroy()
    }

    private inner class AssetClient : WebViewClient() {

        /** Every request is answered from assets/www; nothing goes to the network. */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
            val uri = request.url
            if (uri.scheme != "https" || uri.host != HOST) return notFound()
            var path = uri.path ?: "/"
            if (path.endsWith("/")) path += "index.html"
            if (path.contains("..")) return notFound()
            return try {
                val stream = assets.open("www$path")
                val mime = mimeType(path)
                val encoding = if (mime.startsWith("text/") || mime == "application/json") "utf-8" else null
                WebResourceResponse(mime, encoding, 200, "OK", mapOf("Cache-Control" to "no-cache"), stream)
            } catch (e: IOException) {
                notFound()
            }
        }

        /** The page never navigates anywhere; refuse anything that tries. */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            return !(uri.scheme == "https" && uri.host == HOST)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            pushInsets(null)
        }

        /** If Android kills the WebView's renderer (low memory), start the page again. */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view === web) {
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                web = null
                if (!isFinishing && !isDestroyed) createWebView()
            }
            return true
        }

        private fun notFound() = WebResourceResponse(
            "text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)),
        )

        private fun mimeType(path: String): String = when (path.substringAfterLast('.', "").lowercase(Locale.US)) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "json" -> "application/json"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "webp" -> "image/webp"
            "woff2" -> "font/woff2"
            else -> "application/octet-stream"
        }
    }

    private companion object {
        // The host Android reserves for apps serving their own assets to a WebView.
        const val HOST = "appassets.androidplatform.net"
        const val START_URL = "https://$HOST/index.html"
    }
}
