# Publishing the Android app

The Android app is a Trusted Web Activity: a small signed package (`tech.solpouch.app`) that opens
`https://solpouch.tech` full screen in the phone's browser engine. All product code stays in the
web app, so a web deploy updates the app without a store release. A new store release is needed
only when something in `apps/android` changes (icon, colours, shortcuts, target SDK).

## What is ready

| Item | Where |
|---|---|
| Signed release bundle (upload to Play) | `apps/android/app/build/outputs/bundle/release/app-release.aab` after a build |
| Signed APK (install on a phone directly) | `apps/android/app/build/outputs/apk/release/app-release.apk` |
| Store text | [listing.md](listing.md) |
| Data safety answers | [data-safety.md](data-safety.md) |
| Content rating and app content answers | [content-rating.md](content-rating.md) |
| Icon 512 and feature graphic 1024x500 | [graphics/](graphics) |
| Phone screenshots | [screenshots/](screenshots) |
| Privacy policy URL | `https://solpouch.tech/privacy` |
| Account deletion URL | `https://solpouch.tech/delete-account` |

## Build

Needs JDK 17 or newer and the Android SDK (platform 36, build-tools 35 or newer) with
`ANDROID_HOME` set. Do not create `local.properties`; lint rejects Windows paths in it.

```
cd apps/android
copy keystore.properties.example keystore.properties   # then fill it in
gradlew.bat lintRelease bundleRelease assembleRelease
```

Without `keystore.properties` the release build is unsigned and cannot be uploaded.
Raise `versionCode` in `app/build.gradle.kts` for every upload; Play rejects a repeated number.

## The upload key

The upload keystore is outside git, in the main checkout at `.keys/android/` (the keystore and
its `keystore.properties` with the password). **Back both files up somewhere safe that is not this
machine.** If the key is lost, uploads stop until Google resets the upload key, which takes days.

SHA-256 of the upload certificate:

```
6E:87:50:18:CD:A1:92:62:68:7A:64:7C:9E:FC:F2:1D:70:F0:4C:64:3E:9F:74:52:E1:94:CF:0D:AF:05:80:C6
```

## Steps only the owner can do

These need a person's identity, payment, or a decision, so they are not automated.

1. **Create a Play Console developer account** at play.google.com/console (one-time US$25).
   Google verifies identity, and a personal account must also verify a phone and an Android device
   in the Play Console app. An organisation account needs a D-U-N-S number.
2. **Create the app.** Name `Solpouch`, default language English, type App, Free. Package name is
   set by the first upload: `tech.solpouch.app`.
3. **Keep Play App Signing on** (the default) and upload `app-release.aab` to a testing track.
4. **Add Google's signing fingerprint to the site.** This step is required or the installed app
   shows a browser address bar. In Play Console open Test and release, Setup, App signing, copy
   the SHA-256 under "App signing key certificate", and add it as a second entry in
   `sha256_cert_fingerprints` in `apps/web/public/.well-known/assetlinks.json`. Keep the upload
   fingerprint too, so directly installed builds keep working. Deploy the web app, then check:
   `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://solpouch.tech&relation=delegate_permission/common.handle_all_urls`
5. **Fill in App content** from [data-safety.md](data-safety.md) and
   [content-rating.md](content-rating.md): privacy policy, app access, ads, content rating,
   target audience, data safety, financial features, account deletion URL.
6. **Give reviewers a way in** under App access. The app needs a Google sign-in, so create a
   dedicated test Google account for review and enter its login there. Do not use a personal one.
7. **Fill in the store listing** from [listing.md](listing.md) and upload the graphics and
   screenshots.
8. **Run the closed test.** Personal developer accounts created after November 2023 must run a
   closed test with at least 12 testers opted in for 14 days in a row before they can apply for
   production. Organisation accounts skip this.
9. **Apply for production**, answer the questions about the test, and roll out.

## Before a production release

Be straight with reviewers and users about what the product is today:

- Payments run on Solana **devnet with test USDC**. No real money moves. The listing text says
  so. If the app moves to mainnet, the listing, the data safety form and the financial features
  declaration must be updated first, and some countries need a licence for crypto wallet or
  exchange apps (see Play's "Financial services" policy, cryptocurrency section).
- The financial features declaration in [content-rating.md](content-rating.md) is written for the
  devnet state. Read it again against the policy at submission time, since Google changes the form.

## Checks that were run

See the "Android app" section of `STATUS.md` for what was verified on an emulator and what was
not (it lists the gaps honestly, including anything that needs a signed-in account or a real phone).
