# cordova-plugin-outsystems-custom-domain

A Cordova build-hook plugin that rewrites an OutSystems ODC mobile app's
**built-in domain** (e.g. `yourorg.outsystems.app` / `something.outsystemscloud.com`)
to a **custom domain** you've configured for the stage, before the native
iOS/Android projects are generated.

## Scope and assumptions (read this first)

- This only applies to **Cordova-based** ODC mobile packages. Since MABS 12,
  ODC defaults new mobile packages to **Capacitor**; this plugin does nothing
  for a Capacitor build. In ODC Portal, when generating the mobile package,
  pick a specific MABS version and explicitly choose the **Cordova**
  framework.
- Your custom domain must already be added and set **active** for the stage
  in ODC (Settings > Custom domains), with a valid TLS certificate covering
  it, before you build the app. This plugin only changes what the app shell
  points at - it doesn't provision or validate the domain itself.
- OutSystems doesn't publicly document the exact internal file layout MABS
  generates for a Cordova mobile shell, and it can change between MABS
  versions. This hook works against the **standard Cordova mechanism** for
  hosted apps: the `<content src="https://...">`, `<access origin="...">` and
  `<allow-navigation href="...">` entries in `config.xml`, which is what
  Cordova uses to decide what URL the WebView loads and what it's allowed to
  navigate/call. It also does a best-effort text sweep of the `www` folder
  for any other hard-coded references to the built-in domain. Treat this as
  a solid starting point, and diff the generated `config.xml` (and, if
  needed, the platform-specific `AndroidManifest.xml` / `Info.plist`) on a
  test build before shipping.
- Things tied specifically to the built-in domain outside the WebView load
  URL - e.g. push notification registration endpoints, deep-link
  associations, or any native SDK configured separately - aren't touched by
  this hook and may need their own reconfiguration.

## What the hook does

Registered as a `before_prepare` hook (runs before Cordova copies the root
`config.xml` into `platforms/android` and `platforms/ios`, so the change
propagates to both, including Cordova's own translation of `<access>` /
`<allow-navigation>` into Android's network-security config and iOS's App
Transport Security exceptions):

1. Reads `CUSTOM_DOMAIN` (required) and `BUILTIN_DOMAIN` (optional) from the
   plugin's variables.
   - If `BUILTIN_DOMAIN` isn't set, it's auto-detected from `<content src>`,
     but only if the host matches a known OutSystems shape
     (`*.outsystems.app` or `*.outsystemscloud.com`). Set it explicitly if
     detection fails or your org uses something else.
2. Rewrites the domain inside `<content src="https://BUILTIN/...">` to
   `https://CUSTOM/...`.
3. Adds `<access origin="https://CUSTOM">` and
   `<allow-navigation href="https://CUSTOM/*">` entries if not already
   present.
4. By default, leaves the built-in domain's existing `<access>` /
   `<allow-navigation>` entries in place (set `KEEP_BUILTIN_DOMAIN_ACCESS=false`
   to strip them).
5. Unless disabled, walks `www/**/*.{html,js,json,xml}` and replaces any
   remaining literal occurrences of the built-in domain with the custom
   domain (set `PATCH_WWW_FILES=false` to skip this).
6. Logs what it changed. If `CUSTOM_DOMAIN` is missing or the built-in
   domain can't be resolved, it fails the build with a message prefixed
   `OUTSYSTEMS_PLUGIN_ERROR:` (the convention MABS uses to surface a
   readable custom-hook error instead of a generic failure).

No third-party npm dependencies - only Node builtins - so nothing needs to
be installed inside the MABS build container.

## Plugin variables

| Variable                    | Required | Default | Description                                                              |
|------------------------------|----------|---------|----------------------------------------------------------------------------|
| `CUSTOM_DOMAIN`               | Yes      | -       | The custom domain to switch to, e.g. `myapp.example.com`.                |
| `BUILTIN_DOMAIN`               | No       | auto    | Override auto-detection of the current built-in domain.                  |
| `KEEP_BUILTIN_DOMAIN_ACCESS`   | No       | `true`  | Keep the built-in domain whitelisted alongside the custom one.           |
| `PATCH_WWW_FILES`              | No       | `true`  | Also replace literal domain references inside `www/`.                    |

## Installing with the Cordova CLI

```bash
cordova plugin add cordova-plugin-outsystems-custom-domain \
  --variable CUSTOM_DOMAIN=myapp.example.com
```

Or straight from a Git URL if you're not publishing to npm:

```bash
cordova plugin add https://github.com/YOUR_ORG/cordova-plugin-outsystems-custom-domain.git \
  --variable CUSTOM_DOMAIN=myapp.example.com
```

## Installing in OutSystems ODC

Cordova plugins are added to an ODC mobile app through the module's
**Extensibility Configuration**, as a JSON snippet pointing at the plugin
and its variables, e.g.:

```json
{
  "plugin": {
    "url": "https://github.com/YOUR_ORG/cordova-plugin-outsystems-custom-domain.git#1.0.0",
    "variables": {
      "CUSTOM_DOMAIN": "myapp.example.com"
    }
  }
}
```

Double-check the current field names/shape for Extensibility Configuration
against the ODC documentation for your MABS version before relying on this -
that schema is OutSystems-owned and can change independently of this
plugin. Generate a build and inspect the MABS build log for lines prefixed
`[cordova-plugin-outsystems-custom-domain]` to confirm the hook ran and
what it changed.

## Local testing without a full ODC build

You can sanity-check the hook against any Cordova project:

```bash
cd some-cordova-project
cordova plugin add /path/to/cordova-plugin-outsystems-custom-domain \
  --variable CUSTOM_DOMAIN=myapp.example.com \
  --variable BUILTIN_DOMAIN=yourorg.outsystems.app
cordova prepare
git diff config.xml
```
