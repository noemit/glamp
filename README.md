# Glamp

A small project space for humans and their agents. Your agent submits a Markdown plan from a terminal; you open **the same card** on your phone, mark it Done, and the agent reads the decision back. No copy-pasting between a board and a chat transcript.

**One workspace per deployment.** The source is public under the MIT license. The workspace, uploaded images, and push subscriptions are private.

## One card, several views

| View | What appears there |
| --- | --- |
| Docs | All cards, including notes that are also todos |
| Board | The same cards grouped into Open, Needs review, and Done |
| Todos | Cards with `isTask: true` |
| Calendar | Cards on their creation day, plus any scheduled day or date range |

Every card has a stable link, title, text body, status, and timestamps. `isTask` defaults to false; `startingDate` and `endingDate` are optional independent calendar dates, not midnight timestamps. A start alone means a planned day; an end alone can stand for a due date. Attach private images to any card, with or without dates. There is no separate event, todo, or document to keep in sync.

## Run locally

Requires Node **22.13+** and npm. No cloud accounts needed.

```sh
git clone https://github.com/noemit/glamp.git
cd glamp
npm ci
npm run setup
npm start
```

Open **http://127.0.0.1:3000**. Sign in with `GLAMP_OWNER_TOKEN` from the generated, gitignored `.env`. The setup command also creates an independent agent token and push keys. It never overwrites existing secrets. Local cards and images persist in `.glamp/`; set `GLAMP_DATA_DIR` to change that location. Keep this directory and `.env` private.

### Try the first handoff

In a second terminal, from the checkout:

```sh
npm run glamp -- put examples/launch-plan.md --title 'Launch plan' --task --status review --json
npm run glamp -- search 'Launch plan' --json
npm run glamp -- schema --json
```

Open the card on the board, mark it Done, and run `npm run glamp -- read CARD_UUID --json` with the returned ID. To add a photo: `npm run glamp -- attach CARD_UUID ./reference.png`. Without push enabled, the board handoff still works. Run `npm run glamp -- --help` for the rest of the commands.

For an agent outside the checkout, make the CLI available with `npm link` from the checkout. Give the agent `GLAMP_URL` (your HTTPS Glamp origin) and its own `GLAMP_TOKEN`, **not** your owner token, Neon credential, or connection string. `glamp` talks to the same authenticated card API as the browser. All configured agents can read and write the entire workspace; this is not multi-tenant software.

## Deploy to Vercel + Neon

1. Import this repo as a **new Vercel project** (Express, Node 24). No frontend build or Firebase project is needed. The `public/` directory holds the PWA, and `index.mjs` exports the Express API. Keep the language tutor deployment separate.
2. Pick your Neon project/branch. Create the `glamp` schema and tables by running `sql/schema.sql`, `sql/images.sql`, then `sql/push.sql` in the Neon SQL editor. These files do not migrate or import any existing app's data. Prefer a separate app role with `USAGE` on this schema and the table permissions it needs; never hand that role's connection string to agents. Set its connection string as `DATABASE_URL` in Vercel.
3. Create a **private** [Neon Object Storage](https://neon.com/docs/storage/get-started) bucket for card images. Use the branch endpoint and S3-compatible credentials from Neon, server-side only. Check that Object Storage is available in your project's region. Glamp stores image metadata in Postgres, not the image bytes. See `.env.example` for the exact storage variables.
4. Set `GLAMP_OWNER_TOKEN` to a new strong random secret (32+ characters). For each agent, run `node scripts/agent-key.mjs` **locally**. Send the token to that agent privately; set `GLAMP_AGENT_TOKEN_HASHES` on Vercel to the comma-separated hashes only. Remove one hash and redeploy to revoke that agent. Rotate `GLAMP_OWNER_TOKEN` to invalidate all owner sessions.
5. To enable Web Push, set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (a real `mailto:` contact or HTTPS contact URL). Use a stable keypair for the deployment. Redeploy after setting environment variables. Never commit `.env`, push subscriptions, database URLs, or bucket credentials. Preview and production should not share a writable database branch/bucket or push credentials.

### Verify phone notifications

Open the HTTPS deployment and sign in. On iOS/iPadOS 16.4+, **Add to Home Screen and launch from the installed app first**. Tap the push opt-in and grant permission. From an agent, submit a card with `--status review`. Tapping the notification should open that exact card. Move it to Done and read it back with the CLI. Push is triggered on *entering* review, not on every edit. Actual delivery depends on device permissions and the push service; a failed notification does not undo a saved card.

## Development

`npm test` runs the local suite without cloud credentials. `npm run dev` starts the API in watch mode. No account, database, or bucket is provisioned just by cloning or running the tests.
