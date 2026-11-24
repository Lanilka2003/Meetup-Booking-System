import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

/** Resolve stack outputs: from cdk-outputs.json if present, else from CloudFormation. */
export async function stackOutputs(): Promise<Record<string, string>> {
  const stage = process.env.STAGE || argValue('--stage') || 'dev';
  const stackName = `MeetupBooking-${stage}`;

  try {
    const file = JSON.parse(readFileSync(path.join(__dirname, '..', 'cdk-outputs.json'), 'utf8'));
    if (file[stackName]) return file[stackName] as Record<string, string>;
  } catch {
    // fall back to CloudFormation
  }

  const cf = new CloudFormationClient({});
  const out = await cf.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = out.Stacks?.[0]?.Outputs ?? [];
  return Object.fromEntries(outputs.map((o) => [o.OutputKey!, o.OutputValue!]));
}

export function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
