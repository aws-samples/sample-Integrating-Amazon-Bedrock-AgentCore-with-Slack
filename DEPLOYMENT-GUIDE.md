# Deployment Guide - Weather Agent v2 (CDK)

Complete step-by-step guide for deploying the Weather Agent with Slack integration using AWS CDK.

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Slack App Setup](#slack-app-setup)
3. [Deployment](#deployment)
4. [Slack Configuration](#slack-configuration)
5. [Testing](#testing)
6. [Monitoring](#monitoring)
7. [Cleanup](#cleanup)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Tools
- **AWS CLI** (v2.x): [Installation Guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- **Node.js** (v18+): [Download](https://nodejs.org/)
- **Git**: For cloning the repository

**Note:** Docker is NOT required locally - CodeBuild handles the ARM64 image build in AWS.

### AWS Requirements
- AWS account with appropriate permissions
- AWS CLI configured with credentials:
  ```bash
  aws configure
  ```
- Permissions needed:
  - CloudFormation (for CDK)
  - ECR, Lambda, IAM, API Gateway
  - Bedrock Agent Core
  - Secrets Manager, SQS, CloudWatch

### Verify Prerequisites
```bash
# Check AWS CLI
aws --version

# Check Node.js
node --version

# Verify AWS credentials
aws sts get-caller-identity
```

---

## Slack App Setup

### 1. Create Slack App

1. Go to https://api.slack.com/apps
2. Click **Create New App** → **From scratch**
3. Enter app name (e.g., "Weather Agent")
4. Select your workspace
5. Click **Create App**

### 2. Configure OAuth & Permissions

1. In left sidebar, click **OAuth & Permissions**
2. Scroll to **Scopes** → **Bot Token Scopes**
3. Add these scopes:
   - `app_mentions:read` - View messages that mention the bot
   - `chat:write` - Send messages
   - `im:history` - View direct messages

### 3. Install App to Workspace

1. Scroll to top of **OAuth & Permissions** page
2. Click **Install to Workspace**
3. Review permissions and click **Allow**
4. **Copy the Bot User OAuth Token** (starts with `xoxb-`)
   - Save this - you'll need it for deployment

### 4. Get Signing Secret

1. In left sidebar, click **Basic Information**
2. Scroll to **App Credentials**
3. **Copy the Signing Secret**
   - Save this - you'll need it for deployment

### 5. Enable Event Subscriptions (Later)

We'll configure this after deployment when we have the webhook URL.

---

## Deployment

### 1. Navigate to Project Directory

```bash
cd v2
```

### 2. Set Slack Credentials

```bash
export SLACK_BOT_TOKEN="xoxb-YOUR-BOT-TOKEN-HERE"
export SLACK_SIGNING_SECRET="YOUR-SIGNING-SECRET-HERE"
```

**Important:** Replace with your actual credentials from Slack App setup.

### 3. Run Deployment Script

```bash
./deploy.sh
```

The script will:
1. Navigate to `cdk/` directory
2. Install npm dependencies (if needed)
3. Build TypeScript code
4. Bootstrap CDK (if first time)
5. Deploy all 3 stacks:
   - **WeatherAgentImageStack**: ECR + CodeBuild
   - **WeatherAgentCoreStack**: Runtime + Gateway + Memory
   - **WeatherAgentSlackStack**: Slack integration

### 4. Deployment Progress

You'll see output like:
```
=== Weather Agent CDK Deployment (v2) ===
AWS Account: 123456789012
AWS Region: us-east-1

Installing CDK dependencies...
Building CDK project...
Deploying All Stacks...

WeatherAgentImageStack: deploying...
✅ WeatherAgentImageStack

WeatherAgentCoreStack: deploying...
✅ WeatherAgentCoreStack

WeatherAgentSlackStack: deploying...
✅ WeatherAgentSlackStack
```

### 5. Save Outputs

At the end, you'll see important outputs:
```
Stack Information:
  Image Stack:  WeatherAgentImageStack
  Agent Stack:  WeatherAgentCoreStack
  Slack Stack:  WeatherAgentSlackStack

Resources:
  Runtime ARN:  arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/...
  Gateway ARN:  arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/...
  Webhook URL:  https://abc123.execute-api.us-east-1.amazonaws.com/prod/slack-events
```

**Copy the Webhook URL** - you'll need it for Slack configuration.

---

## Slack Configuration

### 1. Enable Event Subscriptions

1. Go to https://api.slack.com/apps
2. Select your app
3. Click **Event Subscriptions** in left sidebar
4. Toggle **Enable Events** to **On**

### 2. Set Request URL

1. Paste the **Webhook URL** from deployment outputs
2. Slack will verify the URL (should show ✓ Verified)
3. If verification fails, check Lambda logs

### 3. Subscribe to Bot Events

Scroll to **Subscribe to bot events** and add:
- `app_mention` - When someone mentions the bot
- `message.im` - When someone DMs the bot

### 4. Save Changes

1. Click **Save Changes** at bottom
2. Slack may prompt to reinstall - click **Reinstall App**

### 5. Invite Bot to Channels

In any Slack channel:
```
/invite @YourBotName
```

---

## Testing

### Test 1: Direct Message

1. Open Slack
2. Find your bot in the Apps section
3. Send a direct message:
   ```
   What is the weather in Seattle?
   ```
4. Bot should respond with weather information

### Test 2: Channel Mention

1. Go to a channel where bot is invited
2. Mention the bot:
   ```
   @YourBotName What is the weather in Chicago?
   ```
3. Bot should respond in the channel

### Test 3: Conversation Memory

Test that the agent remembers context:
```
User: What is the weather in Dallas?
Bot: [responds with Dallas weather]

User: How about tomorrow?
Bot: [responds with Dallas forecast for tomorrow - remembers location!]

User: What about 2 days from now?
Bot: [responds with Dallas forecast - still remembers!]
```

The agent should remember the location (Dallas) across the conversation thread.

### Test 4: Multiple Tools

Test the tool chain:
```
What is the weather in New York City?
```

This should:
1. Call `get_coordinates` to get lat/lon for NYC
2. Call `get_weather` with those coordinates
3. Return formatted weather information

---

## Monitoring

### CloudWatch Logs

**Agent Integration Lambda:**
```bash
aws logs tail /aws/lambda/WeatherAgentSlackStack-agent-integration --follow
```

**Agent Runtime Logs:**
```bash
aws logs tail /aws/bedrock-agentcore/runtimes/weatheragent_runtime-<runtime-id>-DEFAULT --follow
```

**SQS Integration Lambda:**
```bash
aws logs tail /aws/lambda/WeatherAgentSlackStack-sqs-integration --follow
```

**CodeBuild Logs:**
```bash
aws logs tail /aws/codebuild/WeatherAgentImageStack --follow
```

### Check Stack Status

```bash
aws cloudformation describe-stacks \
  --stack-name WeatherAgentSlackStack \
  --query 'Stacks[0].StackStatus'
```

### View Stack Outputs

```bash
aws cloudformation describe-stacks \
  --stack-name WeatherAgentSlackStack \
  --query 'Stacks[0].Outputs'
```

---

## Cleanup

### Remove All Resources

```bash
cd v2
./cleanup.sh
```

The script will:
1. Prompt for confirmation
2. Destroy all 3 CDK stacks
3. Clean up ECR images
4. Remove CloudWatch log groups

### Manual Cleanup (if needed)

If the script fails, manually delete:

```bash
# Delete stacks
cdk destroy --all --force

# Delete ECR images
aws ecr batch-delete-image \
  --repository-name weather-agent-runtime \
  --image-ids imageTag=latest

# Delete ECR repository
aws ecr delete-repository \
  --repository-name weather-agent-runtime \
  --force
```

---

## Troubleshooting

### Deployment Issues

**Error: "CDK bootstrap required"**
- Run: `cdk bootstrap aws://ACCOUNT-ID/REGION`

**Error: "Insufficient permissions"**
- Verify IAM permissions for CloudFormation, ECR, Lambda, CodeBuild, etc.

### Slack Issues

**No response from bot**
- Check webhook URL is configured correctly
- Verify bot is invited to channel (for mentions)
- Check Lambda logs for errors

**"Verification failed" when setting webhook URL**
- Ensure Lambda is deployed successfully
- Check API Gateway configuration
- Review verification Lambda logs

**Bot responds with error message**
- Check agent integration Lambda logs
- Verify Runtime is running
- Check Gateway configuration

### Runtime Issues

**"Gateway ARN not configured"**
- Check environment variables in Runtime
- Verify Gateway was created successfully
- Review agent-stack.ts configuration

**Tools not working**
- Check Gateway invocation logs in Runtime logs
- Verify Gateway target configuration
- Test tool execution through Gateway

**Memory not working / Agent doesn't remember context**
- Check Memory ID is passed to Runtime
- Verify session IDs are consistent in logs
- Look for "Loaded X conversation turns from memory" in Runtime logs
- Check that messages are being stored: "✅ Stored message in memory"

**"ValidationException: conversation must start with user message"**
- This should be handled automatically by removing leading assistant messages
- Check Runtime logs for "⚠️ Removed X leading assistant message(s)"
- If persists, check memory retrieval logic

### Debugging Commands

**Check Runtime status:**
```bash
aws bedrock-agentcore describe-runtime \
  --runtime-id <runtime-id>
```

**Check Gateway status:**
```bash
aws bedrock-agentcore describe-gateway \
  --gateway-id <gateway-id>
```

**Test Lambda directly:**
```bash
aws lambda invoke \
  --function-name WeatherAgentSlackStack-agent-integration \
  --payload '{"test": true}' \
  response.json
```

**View recent errors:**
```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/WeatherAgentSlackStack-agent-integration \
  --filter-pattern "ERROR"
```

---

## Advanced Configuration

### Change Foundation Model

Edit `cdk/lib/agent-stack.ts`:
```typescript
const foundationModel = props.foundationModel || 'anthropic.claude-3-sonnet-20240229-v1:0';
```

Supported models:
- `us.amazon.nova-pro-v1:0` (default)
- `us.amazon.nova-lite-v1:0`
- `anthropic.claude-3-sonnet-20240229-v1:0`
- `anthropic.claude-3-haiku-20240307-v1:0`

### Adjust Memory Retention

Edit `cdk/lib/agent-stack.ts`:
```typescript
expirationDuration: cdk.Duration.days(30), // Change from 90
```

### Add More Tools

1. Update MCP Lambda inline code in `cdk/lib/agent-stack.ts`
2. Add tool definitions to `toolSchema` array
3. Add handler logic in the Lambda function
4. Update system prompt in `agentcore/agent_runtime.py` if needed
5. Redeploy: `./deploy.sh`

### Enable VPC

Edit `cdk/lib/agent-stack.ts`:
```typescript
networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingVpc({
  vpc: myVpc,
  subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }
})
```

---

## Next Steps

1. **Customize Agent**: Modify `agentcore/agent_runtime.py` to add custom logic
2. **Add Tools**: Extend MCP Lambda with more capabilities
3. **Monitor Usage**: Set up CloudWatch dashboards
4. **Scale**: Adjust Lambda concurrency and timeout settings
5. **Security**: Review IAM policies and enable encryption

## Support Resources

- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/)
- [Bedrock Agent Core Documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/agents.html)
- [Slack API Documentation](https://api.slack.com/docs)
- [Strands SDK Documentation](https://github.com/awslabs/strands)
