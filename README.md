# Meetup Booking — Backend

Serverless backend for the Meetup Booking staff app in [`../frontend`](../frontend). It
implements exactly the REST contract in `frontend/README.md` §12, so the app works against
it with no code changes. You only need to fill in `frontend/.env`.

```
App ──(Bearer JWT)──► API Gateway (HTTP API, Cognito JWT authorizer)
                          │
                          ├─► ApiFunction ──► DynamoDB (Customers, Bookings, Messages, Config)
                          │         └──────► SQS SendQueue ──► WhatsAppWorker ──► WhatsApp Cloud API
                          │                        └─ DLQ (+ CloudWatch alarm)          │
                          └─► /webhooks/whatsapp ◄──────── delivery status webhooks ────┘
                                    (HMAC-verified)
EventBridge Scheduler (daily, Asia/Colombo) ──► RemindersFunction ──► SQS
```

Everything is defined as code with **AWS CDK v2 (TypeScript)** in [`lib/meetup-stack.ts`](lib/meetup-stack.ts).

---

## 1. Database design (DynamoDB)

By default all tables use free-tier provisioned capacity (see `databaseMode` below). They are encrypted, have point-in-time recovery, and are **retained
on `cdk destroy`** so customer data is never lost by accident.

| Table         | Key                 | Indexes                                                                                      | Holds |
| ------------- | ------------------- | -------------------------------------------------------------------------------------------- | ----- |
| **Customers** | `customerId`        | —                                                                                            | One row per phone (`cust-94771234567`): name, phone, `bookingCount` |
| **Bookings**  | `bookingId`         | `byDate`: `entity`=`BOOKING` / `slot`=`YYYY-MM-DD#HH:MM#id`                                   | Bookings, plus `whatsappStatus` + `messageId` of the latest message |
| **Messages**  | `messageId`         | `byCreated` (`entity` / `createdAt`), `byBooking` (`bookingId` / `createdAt`), `byProvider` (`providerMessageId`) | Every WhatsApp send (confirmation, reminder, resend) and its delivery status |
| **Config**    | `pk`                | —                                                                                            | `TEMPLATE#<id>` rows (WhatsApp templates) and the `SETTINGS` row |

Key behaviours:

- **`POST /bookings` is transactional.** The booking, the customer upsert and the `QUEUED`
  message row go in one `TransactWriteItems`, and only then is the send enqueued. If SQS
  rejects the job, the message is marked `FAILED` straight away so staff can resend it.
- **No double sends.** The worker atomically *claims* a `QUEUED` message before calling
  WhatsApp, so SQS redelivery is safe.
- **Statuses only move forward**: `QUEUED → SENT → DELIVERED → READ`, or `FAILED`.
  Out-of-order webhooks are ignored ([`src/shared/status.ts`](src/shared/status.ts)).
- "Today" and reminders use the business timezone (`Asia/Colombo`), not UTC.
- List endpoints read the date range from the `byDate` index and search/filter in memory.
  That's fast and cheap for a single meetup's volume (thousands of bookings).

## 2. Endpoints

| Method | Path | Auth |
| ------ | ---- | ---- |
| GET | `/dashboard` | Cognito |
| GET / POST | `/bookings` (`?search=&filter=today\|upcoming\|completed\|cancelled&limit=&nextToken=`) | Cognito |
| GET | `/bookings/{bookingId}` | Cognito |
| POST | `/bookings/{bookingId}/resend` | Cognito |
| GET | `/messages` (`?search=&filter=QUEUED\|SENT\|DELIVERED\|READ\|FAILED&limit=&nextToken=`) | Cognito |
| GET | `/templates` | Cognito |
| GET / PUT | `/settings` | Cognito |
| GET / POST | `/webhooks/whatsapp` | Meta verify token / `X-Hub-Signature-256` |

Responses use the envelope `{ success: true, data }`. Errors use `{ success: false, message, code }`,
and validation errors add `details: { field: message }`.

---

## 3. Deploy

**Requirements:** Node 20+, an AWS account, and the AWS CLI configured (`aws configure` or SSO).
Docker and SAM are **not** needed, because Lambdas are bundled with the local esbuild.

```bash
cd backend
npm install

# one time per account/region
npx cdk bootstrap

# deploy (stage "dev" by default; outputs are saved to cdk-outputs.json)
npm run deploy
# production:
npm run deploy -- -c stage=prod
```

Then:

```bash
# 1. Seed the WhatsApp templates + default settings into the Config table
npm run seed -- --business-number "+94 70 345 6789"

# 2. Create the first staff account (self sign-up is disabled)
npm run create-user -- --username admin --email owner@example.com \
  --name "Mahaguru Admin" --password 'ChangeMe12345' --group owner

# 3. Point the app at the backend (writes ../frontend/.env)
npm run frontend-env
```

For a non-dev stage, pass `--stage prod` (or `STAGE=prod`) to the scripts.

### Deploy options (`-c key=value`)

| Context | Default | Meaning |
| ------- | ------- | ------- |
| `stage` | `dev` | Stack name `MeetupBooking-<stage>`; `prod` turns on table deletion protection |
| `databaseMode` | `free` | `free` = provisioned capacity inside DynamoDB's always-free 25 RCU / 25 WCU (23/22 used). `ondemand` = pay per request, no capacity limits |
| `existingTables` | `false` | `true` = don't create tables; use the hand-made tables `meetup-customers`, `meetup-bookings`, `meetup-messages`, `meetup-config` (same keys/indexes as §1) |
| `timezone` | `Asia/Colombo` | Business timezone for "today" and reminders |
| `reminderHourLocal` | `8` | Hour (local) the daily reminder job runs, for **tomorrow's** bookings |
| `whatsappDryRun` | `false` | `true` = pretend to send (marks `SENT` with a fake id). Handy before Meta approves templates. Refused for `prod`. |
| `corsOrigins` | none | Only needed for the web preview, e.g. `-c corsOrigins=http://localhost:8081` |

---

## 4. Connect WhatsApp (Meta Cloud API)

1. In **Meta for Developers**, create an app with the **WhatsApp** product and add your business
   phone number. Note the **Phone number ID**.
2. Create a **System User** in Business Settings and generate a **permanent access token** with
   `whatsapp_business_messaging`. Note the **App secret** (App settings → Basic).
3. Put the credentials in the secret created by the stack (`WhatsAppSecretArn` output). A
   random `verifyToken` was already generated, so keep it:

   ```bash
   SECRET_ID=meetup-booking/dev/whatsapp
   aws secretsmanager get-secret-value --secret-id $SECRET_ID --query SecretString --output text
   # copy the verifyToken from above, then:
   aws secretsmanager put-secret-value --secret-id $SECRET_ID --secret-string '{
     "accessToken":   "EAAG...",
     "phoneNumberId": "1234567890",
     "appSecret":     "abcdef...",
     "verifyToken":   "<the generated value>"
   }'
   ```
   Lambdas cache the secret for 5 minutes.
4. **Webhook:** in the app's WhatsApp → Configuration, set the callback URL to the `WebhookUrl`
   output and the verify token to `verifyToken`. Subscribe to the **messages** field.
5. **Templates:** business-initiated messages must use Meta-approved templates. In WhatsApp
   Manager create templates whose **name equals the `templateId`** (`booking_confirmation`,
   `booking_reminder`, …), language `en`, using **named parameters** `{{customer_name}}`,
   `{{date}}`, `{{time}}`, `{{booking_id}}`. The bodies are in
   [`src/shared/templates.ts`](src/shared/templates.ts). If you use positional
   `{{1}}…{{4}}` templates instead, set `WHATSAPP_PARAMETER_FORMAT=positional` on the worker.

In the app, **Settings → WhatsApp connected** turns on as soon as `accessToken` and
`phoneNumberId` are present.

---

## 5. Develop & test

```bash
npm run typecheck
npm test          # unit + handler tests (AWS SDK calls are mocked; no AWS account needed)
npm run synth     # render CloudFormation without deploying
```

## 6. Operations

- **Logs:** CloudWatch log groups `/aws/lambda/MeetupBooking-<stage>-*` (30-day retention).
- **Failed sends:** a message that fails 3 times goes to `FAILED` with a `failureReason`, and staff
  can **Resend** it from Booking Details. The `SendDeadLetterAlarm` fires if jobs reach the DLQ.
- **Backups:** DynamoDB point-in-time recovery (35 days) on every table.
- **Throttling:** the API is limited to 20 req/s (burst 50).
- **Security:** no secrets in the app or in code. WhatsApp credentials live only in Secrets
  Manager. The webhook rejects requests without a valid Meta HMAC signature.
- **Teardown:** `npm run destroy` removes compute and the API. Tables, the user pool and the
  secret are **retained** on purpose. Delete them manually if you really mean to.

## 7. Layout

```
backend/
├── bin/app.ts                 # CDK entry (reads -c context)
├── lib/meetup-stack.ts        # All infrastructure
├── src/handlers/
│   ├── api.ts                 # All authenticated REST routes
│   ├── worker.ts              # SQS → WhatsApp Cloud API
│   ├── webhook.ts             # Meta delivery-status webhooks
│   └── reminders.ts           # Daily reminder job
├── src/shared/                # db, validation, phone, time, templates, status, whatsapp, queue, settings
├── scripts/                   # seed, create-user, frontend-env
└── test/                      # node:test suites
```
