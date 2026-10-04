# Data safety form answers

Play Console, Policy, App content, Data safety. These answers describe what the code does as of
this branch (see `apps/web/src/app/privacy/page.tsx` and `apps/backend/db/schema.sql`). Recheck
them whenever a provider or stored field changes.

## Overview questions

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | Yes |
| Is all of the user data collected by your app encrypted in transit? | Yes (HTTPS only, HSTS) |
| Which methods of account creation does your app support? | OAuth (Google sign-in) |
| Do you provide a way for users to request that their data is deleted? | Yes |
| Delete account URL | `https://solpouch.tech/delete-account` |

## Data types

"Collected" means sent off the device to Solpouch. "Shared" means passed to another company that
is not acting only as a service provider. Providers that process data only to run the service
(Google sign-in, the AI provider, ElevenLabs, the database host, Cloudflare) count as service
providers, so their processing is "collected", not "shared".

| Data type | Collected | Shared | Required or optional | Purposes |
|---|---|---|---|---|
| Personal info: Name | Yes | No | Required | App functionality, Account management |
| Personal info: Email address | Yes | No | Required | App functionality, Account management |
| Personal info: User IDs (linked wallet address) | Yes | No | Optional | App functionality |
| Financial info: Purchase history (orders, pouch balances and limits) | Yes | No | Required | App functionality |
| Financial info: Other financial info (top-ups, withdrawals, wallet funding requests) | Yes | No | Optional | App functionality |
| Photos and videos: Photos (Google profile picture URL) | Yes | No | Required | Account management |
| Messages: Other in-app messages (chat with the assistant) | Yes | No | Optional | App functionality |
| Audio: Voice or sound recordings (voice requests) | Yes | No | Optional | App functionality |
| App activity: Other user-generated content (shopping lists, order requests) | Yes | No | Optional | App functionality |

For every row: processed ephemerally No, except chat messages and voice audio, which Solpouch
does not store (the chat history lives in the open page; voice is handled by ElevenLabs during
the call). If the form asks, mark those two as processed ephemerally.

## Not collected

Location, contacts, calendar, files, health, web browsing history, device or other IDs,
diagnostics and crash logs. The Android package contains no code of its own, no analytics and no
advertising SDK, and requests no permissions beyond what the browser asks for at use time
(microphone, only when the user starts a voice request).

## Things to say honestly if asked

- On-chain transactions are public and cannot be erased. Account deletion removes the records
  Solpouch holds; the privacy policy and the deletion page both say this.
- Deletion is refused while a pouch still holds money or a payment, top-up or withdrawal is in
  progress, so that nothing is stranded. The user empties the pouch first.
