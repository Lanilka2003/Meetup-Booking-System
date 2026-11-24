/**
 * Create a staff account in the Cognito user pool (self sign-up is disabled).
 *
 *   npm run create-user -- --username admin --email owner@example.com \
 *     --name "Mahaguru Admin" --password 'Str0ngPassword!' --group owner
 *
 * --password is required and set as PERMANENT: the app's login screen does not
 * implement Cognito's "new password required" challenge, so users created with a
 * temporary password could not sign in. Users can change it later in Settings.
 * --group is "owner" or "staff" (default: staff).
 */
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

import { argValue, stackOutputs } from './outputs';

async function main() {
  const username = argValue('--username');
  const email = argValue('--email');
  const name = argValue('--name');
  const password = argValue('--password');
  const group = argValue('--group') ?? 'staff';

  if (!username || !email || !password) {
    throw new Error('Usage: npm run create-user -- --username <u> --email <e> --password <p> [--name <n>] [--group owner|staff]');
  }
  if (!['owner', 'staff'].includes(group)) throw new Error('--group must be "owner" or "staff".');
  // Same rules as the user pool's password policy (lib/meetup-stack.ts) — check first so a
  // bad password never leaves a half-created user behind.
  const problems = [
    password.length < 10 && 'at least 10 characters',
    !/[a-z]/.test(password) && 'a lowercase letter',
    !/[A-Z]/.test(password) && 'an uppercase letter',
    !/[0-9]/.test(password) && 'a number',
    /^\s|\s$/.test(password) && 'no space at the start or end',
  ].filter(Boolean);
  if (problems.length) throw new Error(`Password needs ${problems.join(', ')}.`);

  const { UserPoolId } = await stackOutputs();
  if (!UserPoolId) throw new Error('UserPoolId output not found — deploy the stack first.');

  const client = new CognitoIdentityProviderClient({});
  let existed = false;
  try {
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId,
        Username: username,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          ...(name ? [{ Name: 'name', Value: name }] : []),
        ],
        MessageAction: 'SUPPRESS',
      })
    );
  } catch (error) {
    if ((error as Error).name !== 'UsernameExistsException') throw error;
    // Re-running for an existing user just (re)sets the password and group.
    existed = true;
  }

  await client.send(
    new AdminSetUserPasswordCommand({ UserPoolId, Username: username, Password: password, Permanent: true })
  );

  await client.send(new AdminAddUserToGroupCommand({ UserPoolId, Username: username, GroupName: group }));

  console.log(
    `✔ ${existed ? 'Updated existing' : 'Created'} ${group} user "${username}". They can sign in to the app now.`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
