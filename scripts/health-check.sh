#!/usr/bin/env bash
# Read-only health check of the deployed Meetup Booking backend. Changes nothing.
#   npm run check
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=cdk-outputs.json
[ -f "$OUT" ] || { echo "❌ cdk-outputs.json not found — run 'npm run deploy' first."; exit 1; }
val() { python3 -c "import json; print(list(json.load(open('$OUT')).values())[0].get('$1',''))"; }
R=$(val Region); POOL=$(val UserPoolId); API=$(val ApiUrl)
TABLES="$(val CustomersTableName) $(val BookingsTableName) $(val MessagesTableName) $(val ConfigTableName)"
STACK=$(python3 -c "import json; print(list(json.load(open('$OUT')).keys())[0])")
pass=0; fail=0; warn=0
ok()   { echo "  ✅ $1"; pass=$((pass+1)); }
bad()  { echo "  ❌ $1"; fail=$((fail+1)); }
note() { echo "  ⚠️  $1"; warn=$((warn+1)); }

echo "Region $R · stack $STACK"
echo; echo "Backend"
s=$(aws cloudformation describe-stacks --region "$R" --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>&1)
[[ "$s" == *_COMPLETE && "$s" != *ROLLBACK* ]] && ok "Stack: $s" || bad "Stack: $s"
for f in Api WhatsAppWorker WhatsAppWebhook Reminders; do
  n=$(aws lambda list-functions --region "$R" --query "length(Functions[?starts_with(FunctionName,'$STACK-${f}Function')])" --output text)
  [ "$n" = "1" ] && ok "Function $f" || bad "Function $f missing"
done
code=$(curl -s -o /dev/null -w "%{http_code}" "$API/dashboard")
[ "$code" = "401" ] && ok "API online and requires login (401)" || bad "API /dashboard returned $code (expected 401)"

echo; echo "Database"
total_r=0; total_w=0
for t in $TABLES; do
  j=$(aws dynamodb describe-table --region "$R" --table-name "$t" --output json 2>&1) || { bad "Table $t not found"; continue; }
  read -r st r w gr gw dp < <(echo "$j" | python3 -c "
import json,sys; t=json.load(sys.stdin)['Table']; p=t.get('ProvisionedThroughput',{})
g=t.get('GlobalSecondaryIndexes',[])
print(t['TableStatus'], p.get('ReadCapacityUnits',0), p.get('WriteCapacityUnits',0),
  sum(i['ProvisionedThroughput']['ReadCapacityUnits'] for i in g), sum(i['ProvisionedThroughput']['WriteCapacityUnits'] for i in g),
  t.get('DeletionProtectionEnabled',False))")
  total_r=$((total_r+r+gr)); total_w=$((total_w+w+gw))
  [ "$st" = "ACTIVE" ] && ok "Table $t" || bad "Table $t is $st"
  [ "$dp" = "True" ] || note "Deletion protection is off on $t"
done
idx=$(aws dynamodb describe-table --region "$R" --table-name "$(val MessagesTableName)" --query 'Table.GlobalSecondaryIndexes[].IndexName' --output text 2>/dev/null | tr '\t' ' ')
for i in byCreated byBooking byProvider; do [[ " $idx " == *" $i "* ]] && ok "Index $i" || bad "Index $i missing on messages table"; done
idx=$(aws dynamodb describe-table --region "$R" --table-name "$(val BookingsTableName)" --query 'Table.GlobalSecondaryIndexes[].IndexName' --output text 2>/dev/null | tr '\t' ' ')
[[ " $idx " == *" byDate "* ]] && ok "Index byDate" || bad "Index byDate missing on bookings table"
(( total_r <= 25 && total_w <= 25 )) && ok "Free tier: $total_r read / $total_w write units (limit 25)" \
  || bad "Over free tier: $total_r read / $total_w write units (limit 25)"
n=$(aws dynamodb scan --region "$R" --table-name "$(val ConfigTableName)" --select COUNT --query Count --output text)
(( n >= 6 )) && ok "Config: $n items (settings + templates)" || bad "Config has $n items (expected 6)"

echo; echo "Login"
us=$(aws cognito-idp list-users --region "$R" --user-pool-id "$POOL" --query 'Users[].[Username,UserStatus]' --output text)
[ -z "$us" ] && bad "No users — run 'npm run create-user'"
while read -r u status; do
  [ -z "$u" ] && continue
  g=$(aws cognito-idp admin-list-groups-for-user --region "$R" --user-pool-id "$POOL" --username "$u" --query 'Groups[].GroupName' --output text)
  if [ "$status" = "CONFIRMED" ] && [ -n "$g" ]; then ok "User $u: $status, group $g"
  else bad "User $u: $status, group '${g:-none}' — re-run 'npm run create-user' with a valid password"; fi
done <<< "$us"

echo; echo "WhatsApp"
for q in $(aws sqs list-queues --region "$R" --queue-name-prefix "$STACK" --query QueueUrls --output text); do
  c=$(aws sqs get-queue-attributes --region "$R" --queue-url "$q" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)
  if [[ "$q" == *DeadLetter* ]]; then [ "$c" = "0" ] && ok "Dead-letter queue empty" || bad "$c failed jobs in dead-letter queue"
  else ok "Send queue ($c waiting)"; fi
done
dry=$(aws lambda get-function-configuration --region "$R" --function-name "$(aws lambda list-functions --region "$R" --query "Functions[?starts_with(FunctionName,'$STACK-WhatsAppWorker')].FunctionName" --output text)" --query 'Environment.Variables.WHATSAPP_DRY_RUN' --output text)
sec=$(aws secretsmanager get-secret-value --region "$R" --secret-id "meetup-booking/$(val Region >/dev/null; python3 -c "print('$STACK'.split('-',1)[1])")/whatsapp" --query SecretString --output text 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(' '.join(k for k in ('accessToken','phoneNumberId','appSecret') if not d.get(k)))")
if [ "$dry" = "true" ]; then note "Test mode (dry run): messages are marked Sent but not delivered"
elif [ -z "$sec" ]; then ok "WhatsApp credentials set"
else note "WhatsApp not connected (missing: $sec) — bookings will show WhatsApp 'Failed'"; fi
st=$(aws scheduler list-schedules --region "$R" --name-prefix "$STACK" --query 'Schedules[0].State' --output text)
[ "$st" = "ENABLED" ] && ok "Daily reminder schedule enabled" || bad "Reminder schedule: $st"

echo; echo "App"
if [ -f ../frontend/.env ] && grep -q "$POOL" ../frontend/.env && grep -q "USE_MOCK=false" ../frontend/.env; then ok "frontend/.env points at this backend"
else bad "frontend/.env missing or outdated — run 'npm run frontend-env -- --force'"; fi

echo; echo "Errors in the last hour"
for g in $(aws logs describe-log-groups --region "$R" --query "logGroups[?contains(logGroupName,'$STACK')].logGroupName" --output text); do
  e=$(aws logs filter-log-events --region "$R" --log-group-name "$g" --start-time $(( ($(date +%s)-3600)*1000 )) \
      --filter-pattern '?ERROR ?Unhandled' --query 'length(events)' --output text 2>/dev/null | awk '{s+=$1} END {print s+0}')
  name=$(echo "$g" | sed -E "s/.*$STACK-([A-Za-z]+)Function.*/\1/")
  [ "${e:-0}" = "0" ] && ok "$name: no errors" || bad "$name: $e errors (CloudWatch → Log groups)"
done

echo; echo "Result: $pass passed · $warn warnings · $fail problems"
[ "$fail" = "0" ]
