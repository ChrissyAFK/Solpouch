# Phone screenshots

Real captures, 1080x1920 (9:16), taken on 2026-10-03 from Chrome 124 on an Android emulator
(1080x2400, 420 dpi). Each is the page content only, captured through the browser's remote
debugging screenshot call and cropped from 1080x2201 to the top 1920 rows. Nothing was drawn on or
edited.

| File | Screen | Source |
|---|---|---|
| `01-home.png` | Home page | local production build of this branch |
| `02-sign-in.png` | Sign-in card on the dashboard | live `https://solpouch.tech/dashboard` |
| `03-about.png` | About page | local production build of this branch |
| `04-delete-account.png` | Account deletion page | local production build of this branch |

## What is missing

All four are signed-out screens. The screens that sell the app (pouches, an order being approved,
the order history) need a signed-in account, and no test account existed when these were taken.
Before the store listing goes live, sign in on a phone with the review test account
(PUBLISHING.md, step 6), fund a pouch with devnet USDC, and replace `03` and `04` with captures of
the pouch list and an order. Play accepts 2 to 8 screenshots; these four are enough to submit a
closed test.
