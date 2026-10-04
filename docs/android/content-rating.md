# Content rating and app content answers

Play Console, Policy, App content. Google changes these forms from time to time; where a question
below does not appear, skip it, and where a new one appears, answer it from the facts in this file.

## Content rating questionnaire (IARC)

| Question | Answer |
|---|---|
| Category | Utility, Productivity, Communication or Other |
| Violence, blood, fear | No |
| Sexuality, nudity | No |
| Language (profanity, crude humour) | No |
| Controlled substances (drugs, alcohol, tobacco) | No |
| Gambling, simulated gambling | No |
| Can users interact or exchange content with other users? | No |
| Does the app share the user's current location with other users? | No |
| Does the app allow users to purchase digital goods? | No |
| Is the app a web browser or search engine? | No |
| Is the app primarily a news or educational product? | No |

Expected result: Everyone / PEGI 3. The assistant chat talks only to the service, not to other users.

## Target audience and content

| Question | Answer |
|---|---|
| Target age groups | 18 and over |
| Could the store listing unintentionally appeal to children? | No |

## Ads

The app contains no ads.

## App access

All functionality is behind Google sign-in. Choose "All or some functionality is restricted" and
give the login of a dedicated review account (see PUBLISHING.md, step 6). Add the note: "Sign in
with Google using the account provided. The app runs on Solana devnet with test funds; no real
payment is needed to try any feature."

## Financial features declaration

As of this branch:

| Question | Answer |
|---|---|
| Does your app provide financial features? | Yes |
| Which features | Cryptocurrency software wallet (non-custodial test-network vaults); budgeting and money management |
| Personal loans, banking, payments licence, trading, exchange | No |

Notes for the reviewer field: "Solpouch is a budgeting tool. Each budget ('pouch') is a
program-controlled vault on the Solana devnet holding test USDC. No real funds are held,
exchanged or transmitted, and the app does not buy, sell or trade cryptocurrency."

This answer is only true while the product runs on devnet. Before moving to mainnet, read Play's
Financial services policy again: wallet and exchange apps need to meet local licensing rules in
several countries, and the declaration must be updated before the release that enables real funds.

## Other declarations

| Item | Answer |
|---|---|
| Government app | No |
| Health app | No |
| News app | No |
| COVID-19 contact tracing or status | No |
| Data safety | See data-safety.md |
| Advertising ID | Not used (the manifest does not request `AD_ID`) |
