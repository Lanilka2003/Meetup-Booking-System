import * as path from 'node:path';

import { CfnOutput, Duration, RemovalPolicy, Stack, TimeZone, type StackProps } from 'aws-cdk-lib';
import { CorsHttpMethod, HttpApi, HttpMethod, type CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { AttributeType, BillingMode, Table, TableEncryption, type ITable, type TableProps } from 'aws-cdk-lib/aws-dynamodb';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, OutputFormat, type NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Schedule, ScheduleExpression } from 'aws-cdk-lib/aws-scheduler';
import { LambdaInvoke } from 'aws-cdk-lib/aws-scheduler-targets';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

export interface MeetupStackProps extends StackProps {
  stage: string;
  timezone: string;
  reminderHourLocal: number;
  whatsappDryRun: boolean;
  corsOrigins: string[];
  /** "free" = provisioned capacity inside the DynamoDB free tier; "ondemand" = pay per request. */
  databaseMode: 'free' | 'ondemand';
  /** true = use tables created by hand in the console instead of creating them. */
  existingTables: boolean;
}

/** Table names to create by hand when deploying with `-c existingTables=true`. */
export const EXISTING_TABLE_NAMES = {
  customers: 'meetup-customers',
  bookings: 'meetup-bookings',
  messages: 'meetup-messages',
  config: 'meetup-config',
};

const MAX_SEND_ATTEMPTS = 3;

/**
 * Free-tier capacity plan: [read units, write units] per table and per index.
 * DynamoDB's always-free allowance is 25 RCU + 25 WCU in total across ALL tables
 * and indexes in the account, so the sums below must stay ≤ 25.
 * Reads go mostly to the list indexes (dashboard, bookings, messages); every
 * message status change also writes to the message indexes.
 */
const CAPACITY = {
  customers: [2, 2],
  bookings: [3, 3],
  bookingsByDate: [5, 3],
  messages: [3, 3],
  messagesByCreated: [5, 3],
  messagesByBooking: [2, 3],
  messagesByProvider: [1, 3],
  config: [2, 2],
} as const satisfies Record<string, readonly [number, number]>;
type CapacityKey = keyof typeof CAPACITY;
const FREE_TIER_UNITS = 25;

function assertFreeTierCapacity(): void {
  const values = Object.values(CAPACITY);
  const reads = values.reduce((n, [r]) => n + r, 0);
  const writes = values.reduce((n, [, w]) => n + w, 0);
  if (reads > FREE_TIER_UNITS || writes > FREE_TIER_UNITS) {
    throw new Error(`Free-tier capacity exceeded: ${reads} RCU / ${writes} WCU (limit ${FREE_TIER_UNITS} each).`);
  }
}

export class MeetupBookingStack extends Stack {
  constructor(scope: Construct, id: string, props: MeetupStackProps) {
    super(scope, id, props);
    const isProd = props.stage === 'prod';

    // ─── Auth: Cognito user pool (staff only, admin-created accounts) ───────
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `meetup-booking-${props.stage}`,
      selfSignUpEnabled: false,
      signInAliases: { username: true, email: true },
      signInCaseSensitive: false,
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      autoVerify: { email: true },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: {
        minLength: 10,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
        tempPasswordValidity: Duration.days(7),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const userPoolClient = userPool.addClient('MobileClient', {
      userPoolClientName: 'meetup-booking-app',
      generateSecret: false, // public mobile client
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
    });

    new cognito.CfnUserPoolGroup(this, 'OwnerGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'owner',
      description: 'Meetup owner — full access',
    });
    new cognito.CfnUserPoolGroup(this, 'StaffGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'staff',
      description: 'Meetup staff',
    });

    // ─── Database: DynamoDB tables ──────────────────────────────────────────
    // "free" (default): PROVISIONED capacity that fits inside DynamoDB's
    //   always-free allowance of 25 RCU + 25 WCU per account (see CAPACITY).
    // "ondemand": pay-per-request — scales automatically, billed per request.
    // existingTables=true: use the 4 tables you created by hand in the console
    //   (names in EXISTING_TABLE_NAMES). CDK only grants the Lambdas access to them.
    const createTables = () => {
      const freeDb = props.databaseMode === 'free';
      if (freeDb) assertFreeTierCapacity();
      const cap = (key: CapacityKey) =>
        freeDb ? { readCapacity: CAPACITY[key][0], writeCapacity: CAPACITY[key][1] } : {};

      const tableDefaults: Partial<TableProps> = {
        billingMode: freeDb ? BillingMode.PROVISIONED : BillingMode.PAY_PER_REQUEST,
        encryption: TableEncryption.AWS_MANAGED,
        // Backups cost ~$0.20 per GB-month; this app's data is a few MB, so well under $0.01.
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        deletionProtection: isProd,
        // Customer data must survive `cdk destroy`.
        removalPolicy: RemovalPolicy.RETAIN,
      };

      const customersTable = new Table(this, 'CustomersTable', {
        ...tableDefaults,
        ...cap('customers'),
        partitionKey: { name: 'customerId', type: AttributeType.STRING },
      });

      const bookingsTable = new Table(this, 'BookingsTable', {
        ...tableDefaults,
        ...cap('bookings'),
        partitionKey: { name: 'bookingId', type: AttributeType.STRING },
      });
      bookingsTable.addGlobalSecondaryIndex({
        indexName: 'byDate',
        partitionKey: { name: 'entity', type: AttributeType.STRING },
        sortKey: { name: 'slot', type: AttributeType.STRING },
        ...cap('bookingsByDate'),
      });

      const messagesTable = new Table(this, 'MessagesTable', {
        ...tableDefaults,
        ...cap('messages'),
        partitionKey: { name: 'messageId', type: AttributeType.STRING },
      });
      messagesTable.addGlobalSecondaryIndex({
        indexName: 'byCreated',
        partitionKey: { name: 'entity', type: AttributeType.STRING },
        sortKey: { name: 'createdAt', type: AttributeType.STRING },
        ...cap('messagesByCreated'),
      });
      messagesTable.addGlobalSecondaryIndex({
        indexName: 'byBooking',
        partitionKey: { name: 'bookingId', type: AttributeType.STRING },
        sortKey: { name: 'createdAt', type: AttributeType.STRING },
        ...cap('messagesByBooking'),
      });
      messagesTable.addGlobalSecondaryIndex({
        indexName: 'byProvider',
        partitionKey: { name: 'providerMessageId', type: AttributeType.STRING },
        ...cap('messagesByProvider'),
      });

      const configTable = new Table(this, 'ConfigTable', {
        ...tableDefaults,
        ...cap('config'),
        partitionKey: { name: 'pk', type: AttributeType.STRING },
      });
      return { customersTable, bookingsTable, messagesTable, configTable };
    };
    const importTables = () => {
      const use = (id: string, tableName: string): ITable =>
        Table.fromTableAttributes(this, id, { tableName, grantIndexPermissions: true });
      return {
        customersTable: use('CustomersTable', EXISTING_TABLE_NAMES.customers),
        bookingsTable: use('BookingsTable', EXISTING_TABLE_NAMES.bookings),
        messagesTable: use('MessagesTable', EXISTING_TABLE_NAMES.messages),
        configTable: use('ConfigTable', EXISTING_TABLE_NAMES.config),
      };
    };
    const { customersTable, bookingsTable, messagesTable, configTable }: Record<
      'customersTable' | 'bookingsTable' | 'messagesTable' | 'configTable',
      ITable
    > = props.existingTables ? importTables() : createTables();

    // ─── WhatsApp credentials (filled in after deploy — never in code) ──────
    const whatsappSecret = new Secret(this, 'WhatsAppSecret', {
      secretName: `meetup-booking/${props.stage}/whatsapp`,
      description: 'WhatsApp Cloud API credentials: accessToken, phoneNumberId, appSecret, verifyToken',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ accessToken: '', phoneNumberId: '', appSecret: '' }),
        generateStringKey: 'verifyToken',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ─── Queue: WhatsApp sends ──────────────────────────────────────────────
    const workerTimeout = Duration.seconds(30);
    const deadLetterQueue = new Queue(this, 'SendDeadLetterQueue', {
      retentionPeriod: Duration.days(14),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    const sendQueue = new Queue(this, 'SendQueue', {
      visibilityTimeout: Duration.seconds(workerTimeout.toSeconds() * 6),
      retentionPeriod: Duration.days(4),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: MAX_SEND_ATTEMPTS },
    });

    // ─── Lambdas ────────────────────────────────────────────────────────────
    const commonEnv = {
      CUSTOMERS_TABLE: customersTable.tableName,
      BOOKINGS_TABLE: bookingsTable.tableName,
      MESSAGES_TABLE: messagesTable.tableName,
      CONFIG_TABLE: configTable.tableName,
      SEND_QUEUE_URL: sendQueue.queueUrl,
      WHATSAPP_SECRET_ARN: whatsappSecret.secretArn,
      WHATSAPP_DRY_RUN: String(props.whatsappDryRun),
      MAX_SEND_ATTEMPTS: String(MAX_SEND_ATTEMPTS),
      TIMEZONE: props.timezone,
      NODE_OPTIONS: '--enable-source-maps',
    };

    const fn = (id: string, entry: string, extra: Partial<NodejsFunctionProps> = {}) =>
      new NodejsFunction(this, id, {
        entry: path.join(__dirname, '..', 'src', 'handlers', entry),
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: 512,
        timeout: Duration.seconds(15),
        environment: commonEnv,
        logGroup: new LogGroup(this, `${id}Logs`, {
          retention: RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        bundling: {
          minify: true,
          sourceMap: true,
          target: 'node22',
          format: OutputFormat.CJS,
          externalModules: ['@aws-sdk/*'], // provided by the Lambda runtime
        },
        ...extra,
      });

    const apiFn = fn('ApiFunction', 'api.ts');
    const workerFn = fn('WhatsAppWorkerFunction', 'worker.ts', { timeout: workerTimeout });
    const webhookFn = fn('WhatsAppWebhookFunction', 'webhook.ts');
    const remindersFn = fn('RemindersFunction', 'reminders.ts', { timeout: Duration.minutes(2) });

    for (const table of [customersTable, bookingsTable, messagesTable, configTable]) {
      table.grantReadWriteData(apiFn);
      table.grantReadWriteData(remindersFn);
    }
    for (const table of [bookingsTable, messagesTable, configTable]) {
      table.grantReadWriteData(workerFn);
    }
    messagesTable.grantReadWriteData(webhookFn);
    bookingsTable.grantReadWriteData(webhookFn);

    sendQueue.grantSendMessages(apiFn);
    sendQueue.grantSendMessages(remindersFn);
    whatsappSecret.grantRead(apiFn); // only to report "WhatsApp connected"
    whatsappSecret.grantRead(workerFn);
    whatsappSecret.grantRead(webhookFn);

    workerFn.addEventSource(
      new SqsEventSource(sendQueue, {
        batchSize: 5,
        reportBatchItemFailures: true,
        maxConcurrency: 5, // stay well under WhatsApp's per-number throughput
      })
    );

    // ─── HTTP API (API Gateway v2) with Cognito JWT authorizer ──────────────
    const httpApi = new HttpApi(this, 'HttpApi', {
      apiName: `meetup-booking-${props.stage}`,
      description: 'Meetup Booking REST API',
      ...(props.corsOrigins.length
        ? {
            corsPreflight: {
              allowOrigins: props.corsOrigins,
              allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.PUT],
              allowHeaders: ['Authorization', 'Content-Type'],
              maxAge: Duration.hours(1),
            },
          }
        : {}),
    });

    // Throttle the whole API to protect DynamoDB/WhatsApp from a runaway client.
    const stage = httpApi.defaultStage?.node.defaultChild as CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 50, throttlingRateLimit: 20 };

    const authorizer = new HttpUserPoolAuthorizer('CognitoAuthorizer', userPool, {
      userPoolClients: [userPoolClient],
    });
    const apiIntegration = new HttpLambdaIntegration('ApiIntegration', apiFn);

    const routes: [HttpMethod, string][] = [
      [HttpMethod.GET, '/dashboard'],
      [HttpMethod.GET, '/bookings'],
      [HttpMethod.POST, '/bookings'],
      [HttpMethod.GET, '/bookings/{bookingId}'],
      [HttpMethod.POST, '/bookings/{bookingId}/resend'],
      [HttpMethod.GET, '/messages'],
      [HttpMethod.GET, '/templates'],
      [HttpMethod.GET, '/settings'],
      [HttpMethod.PUT, '/settings'],
    ];
    for (const [method, routePath] of routes) {
      httpApi.addRoutes({ path: routePath, methods: [method], integration: apiIntegration, authorizer });
    }

    // Public — authenticated by Meta's HMAC signature inside the Lambda.
    httpApi.addRoutes({
      path: '/webhooks/whatsapp',
      methods: [HttpMethod.GET, HttpMethod.POST],
      integration: new HttpLambdaIntegration('WebhookIntegration', webhookFn),
    });

    // ─── Daily reminders (EventBridge Scheduler, business timezone) ─────────
    new Schedule(this, 'DailyReminders', {
      description: 'Queue WhatsApp reminders for tomorrow’s bookings',
      schedule: ScheduleExpression.cron({
        minute: '0',
        hour: String(props.reminderHourLocal),
        timeZone: TimeZone.of(props.timezone),
      }),
      target: new LambdaInvoke(remindersFn, {}),
    });

    // ─── Alarm: messages that exhausted all retries ─────────────────────────
    new Alarm(this, 'SendDeadLetterAlarm', {
      alarmDescription: 'WhatsApp send jobs landed in the dead-letter queue',
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    // ─── Outputs (copy into frontend/.env) ──────────────────────────────────
    new CfnOutput(this, 'Region', { value: this.region });
    new CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint, description: 'EXPO_PUBLIC_API_BASE_URL' });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId, description: 'EXPO_PUBLIC_COGNITO_USER_POOL_ID' });
    new CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'EXPO_PUBLIC_COGNITO_USER_POOL_CLIENT_ID',
    });
    new CfnOutput(this, 'WebhookUrl', { value: `${httpApi.apiEndpoint}/webhooks/whatsapp` });
    new CfnOutput(this, 'WhatsAppSecretArn', { value: whatsappSecret.secretArn });
    new CfnOutput(this, 'ConfigTableName', { value: configTable.tableName });
    new CfnOutput(this, 'CustomersTableName', { value: customersTable.tableName });
    new CfnOutput(this, 'BookingsTableName', { value: bookingsTable.tableName });
    new CfnOutput(this, 'MessagesTableName', { value: messagesTable.tableName });
  }
}
