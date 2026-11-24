import { App, Tags } from 'aws-cdk-lib';

import { MeetupBookingStack } from '../lib/meetup-stack';

const app = new App();

// Override any of these with `-c key=value`, e.g. `npx cdk deploy -c stage=prod`.
const stage = String(app.node.tryGetContext('stage') ?? 'dev');
const timezone = String(app.node.tryGetContext('timezone') ?? 'Asia/Colombo');
const reminderHourLocal = Number(app.node.tryGetContext('reminderHourLocal') ?? 8);
const whatsappDryRun = String(app.node.tryGetContext('whatsappDryRun') ?? 'false') === 'true';
const corsRaw = app.node.tryGetContext('corsOrigins') ?? [];
const corsOrigins: string[] = Array.isArray(corsRaw)
  ? corsRaw
  : String(corsRaw).split(',').map((s) => s.trim()).filter(Boolean);

const databaseMode = String(app.node.tryGetContext('databaseMode') ?? 'free');
if (databaseMode !== 'free' && databaseMode !== 'ondemand') {
  throw new Error('databaseMode must be "free" or "ondemand".');
}

if (stage === 'prod' && whatsappDryRun) {
  throw new Error('whatsappDryRun must not be enabled for the prod stage.');
}

const stack = new MeetupBookingStack(app, `MeetupBooking-${stage}`, {
  stage,
  timezone,
  reminderHourLocal,
  whatsappDryRun,
  corsOrigins,
  databaseMode,
  existingTables: String(app.node.tryGetContext('existingTables') ?? 'false') === 'true',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: `Meetup Booking backend (${stage}) — API, DynamoDB, SQS, WhatsApp`,
});

Tags.of(stack).add('app', 'meetup-booking');
Tags.of(stack).add('stage', stage);
