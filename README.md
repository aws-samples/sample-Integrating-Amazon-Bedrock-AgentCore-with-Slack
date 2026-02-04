> [!NOTE]
> The content presented here serves as an example intended solely for educational objectives and should not be implemented in a live production environment without proper modifications and rigorous testing.
> This readme will be updated with blog post once approved.  Please follow instructions found in the draft blog post.

# Weather Agent with Slack Integration

Amazon Bedrock Agent Core Runtime integrated with Slack using AWS CDK for infrastructure deployment.

## Architecture

**Gateway-based architecture with Memory:**
```
Slack → API Gateway → Lambda → SQS → Lambda → Agent Runtime → Gateway → MCP Lambda
                                                      ↕
                                              Agent Core Memory
```

The Agent Runtime invokes tools through the Agent Core Gateway (not directly), which routes requests to the MCP Lambda server. Conversation history is stored and retrieved from Agent Core Memory for context continuity.

## What's Included

### Infrastructure (CDK)
- **Image Stack**: ECR repository + ARM64 CodeBuild for Docker image
- **Agent Stack**: Agent Core Runtime, Gateway, MCP Lambda server, Memory
- **Slack Stack**: API Gateway, Lambda functions, SQS queues, Secrets Manager

### Runtime Code
- `agent_runtime.py`: Python agent using Strands SDK with Gateway integration and Memory
- `streamable_http_sigv4.py`: Custom HTTP client with SigV4 signing for Gateway communication
- `Dockerfile`: Container image for Agent Runtime
- `requirements.txt`: Python dependencies 

### Scripts
- `deploy.sh`: Deploy all 3 CDK stacks with CLI parameters
- `cleanup.sh`: Destroy all resources with region support

## Cost

You are responsible for the cost of the AWS services used while running this guidance.

As of February 2025, the cost for running this guidance with the default settings in the US East (N. Virginia) Region is approximately **$50.00** per month for moderate usage (1,000 Slack messages with agent interactions).

We recommend creating a [Budget](https://console.aws.amazon.com/billing/home#/budgets) through [AWS Cost Explorer](https://aws.amazon.com/aws-cost-management/aws-cost-explorer/) to help manage costs. Prices are subject to change. For full details, refer to the pricing webpage for each AWS service used in this guidance.

### Sample Cost Table

| AWS Service | Dimensions | Cost (USD) |
|-------------|------------|------------|
| Amazon Bedrock AgentCore Runtime | 1,000 sessions/month, 3 min avg duration | $15.00/month |
| Amazon Bedrock (Nova Pro) | 1,000 conversations, 2K input + 1K output tokens avg | $20.00/month |
| AWS Lambda | 5,000 invocations/month, 512MB memory, 1s avg duration | $5.00/month |
| Amazon SQS | 5,000 messages/month | $0.00/month |
| Amazon API Gateway | 5,000 requests/month | $0.02/month |
| Amazon ECR | 1GB storage | $0.10/month |
| AWS CodeBuild | 10 builds/month, 5 min avg duration | $0.50/month |
| AWS Secrets Manager | 2 secrets | $0.80/month |
| Amazon CloudWatch Logs | 5GB ingestion, 1GB storage | $3.00/month |

**Note**: Costs scale with usage. The cleanup script helps avoid ongoing charges when the system is not in use.

## Prerequisites

1. **AWS CLI** configured with credentials
2. **AWS CDK CLI** v2.103.0 or later
   - This project uses CDK schema version 48.0.0, which requires AWS CDK CLI v2.103.0 or later
   - Check your version: `cdk --version`
   - Upgrade if needed: `npm install -g aws-cdk@latest`
   - Without the correct version, you may see this error:
     ```
     This CDK CLI is not compatible with the CDK library used by your application.
     Maximum schema version supported is 44.x.x, but found 48.0.0
     ```
3. **Node.js** (v18+) and npm
4. **Slack App** created with:
   - Bot Token (starts with `xoxb-`)
   - Signing Secret
   - Bot Token Scopes: `app_mentions:read`, `chat:write`, `im:history`
   - Event Subscriptions: `app_mention`, `message.im`

**Note:** Docker is NOT required locally - CodeBuild handles the image build in AWS.

## Quick Start

### 1. Deploy

**Option 1: Using CLI parameters (recommended)**
```bash
./deploy.sh --region us-east-1 \
  --slack-token xoxb-your-token \
  --slack-secret your-signing-secret \
  --yes
```

**Option 2: Using environment variables**
```bash
# Set Slack credentials
export SLACK_BOT_TOKEN="xoxb-your-token"
export SLACK_SIGNING_SECRET="your-signing-secret"

# Deploy all stacks
./deploy.sh
```

**Available deploy.sh options:**
- `-h, --help` - Display help message
- `-r, --region REGION` - AWS region (default: us-east-1)
- `-t, --slack-token TOKEN` - Slack bot token
- `-s, --slack-secret SECRET` - Slack signing secret
- `-S, --skip-slack` - Skip Slack credentials (use placeholders)
- `-y, --yes` - Auto-approve all prompts (non-interactive)
- `-m, --model MODEL` - Foundation model ID (default: us.amazon.nova-pro-v1:0)
- `-v, --verbose` - Enable verbose output

**Examples:**
```bash
# Deploy to specific region
./deploy.sh --region us-west-2

# Non-interactive deployment for CI/CD
./deploy.sh --yes --skip-slack

# Deploy with custom model
./deploy.sh --model anthropic.claude-3-sonnet-20240229-v1:0
```

The script will:
- Validate AWS credentials and display account/role information
- Validate Slack token with Slack API (shows workspace info)
- Install CDK dependencies
- Build TypeScript
- Bootstrap CDK (if needed)
- Deploy all 3 stacks in order with progress indicators
- Display webhook URL and other outputs

### 2. Configure Slack

After deployment completes:

1. Copy the **Webhook URL** from the output
2. Go to https://api.slack.com/apps
3. Select your app → **Event Subscriptions**
4. Set **Request URL** to the webhook URL
5. Save changes
6. Invite bot to channels: `/invite @YourBotName`

### 3. Test

**Direct Message:**
```
What is the weather in Seattle?
```

**Channel Mention:**
```
@YourBotName What is the weather in Chicago?
```

### 4. Monitor Logs

```bash
# Agent integration Lambda
aws logs tail /aws/lambda/WeatherAgentSlackStack-agent-integration --follow

# Runtime logs (if available)
aws logs tail /aws/bedrock-agentcore/runtime/weatheragent_runtime --follow
```

## Cleanup

**Option 1: Using CLI parameters**
```bash
./cleanup.sh --region us-east-1
```

**Option 2: Using environment variables**
```bash
export AWS_REGION=us-east-1
./cleanup.sh
```

**Available cleanup.sh options:**
- `-h, --help` - Display help message
- `-r, --region REGION` - AWS region (default: us-east-1)

This will:
- Destroy all 3 CDK stacks (including failed stacks)
- Clean up ECR images
- Remove CloudWatch log groups
- Preserve CDK staging buckets (may be used by other apps)

## Project Structure

```
.
├── cdk/                      # CDK infrastructure code
│   ├── bin/
│   │   └── app.ts           # CDK app entry point
│   ├── lib/
│   │   ├── image-stack.ts   # Stack 1: Docker image build
│   │   ├── agent-stack.ts   # Stack 2: Agent Core resources
│   │   └── slack-stack.ts   # Stack 3: Slack integration
│   ├── package.json
│   ├── tsconfig.json
│   └── cdk.json
├── agentcore/               # Agent runtime code
│   ├── agent_runtime.py    # Agent runtime code
│   ├── Dockerfile          # Container image
│   └── requirements.txt    # Python dependencies
├── deploy.sh               # Deployment script
├── cleanup.sh              # Cleanup script
├── STRUCTURE.md            # Project structure details
├── LICENSE                 # Apache 2.0 License
└── README.md               # This file
```

## Available Tools

The agent has access to these weather tools via Gateway:

1. **get_current_time**: Get current time for a timezone
2. **get_coordinates**: Get latitude/longitude for a location
3. **get_weather**: Get current weather for coordinates
4. **get_forecast**: Get weather forecast for next 1-5 days
5. **get_historical_weather**: Get historical weather for past 1-5 days

## Configuration

### Environment Variables (Runtime)

Set in `cdk/lib/agent-stack.ts`:
- `GATEWAY_ARN`: Agent Core Gateway ARN (auto-configured)
- `MEMORY_ID`: Agent Core Memory ID (auto-configured)
- `MODEL_ID`: Foundation model (default: `us.amazon.nova-pro-v1:0`)
- `AWS_REGION`: AWS region (auto-configured)
- `AGENT_IDENTITY_ARN`: Agent Core Identity ARN (optional, default: NONE)

### Slack Credentials

Set before deployment:
- `SLACK_BOT_TOKEN`: Bot user OAuth token
- `SLACK_SIGNING_SECRET`: Signing secret for request verification

## Troubleshooting

### Deployment fails with "TriggerBuild failed"
- Ensure Docker is running
- Check CodeBuild logs in CloudWatch

### No response in Slack
- Verify webhook URL is configured in Slack
- Check Lambda logs for errors
- Ensure bot has correct permissions

### "Gateway ARN not configured" error
- Check Runtime environment variables in CDK
- Verify Gateway was created successfully

### Tools not working
- Check Gateway target configuration
- Verify MCP Lambda has correct permissions
- Review Gateway invocation logs

## Features

1. **Conversation Memory**: Remembers context across messages in a thread
2. **Session Management**: Each Slack thread maintains its own conversation history
3. **Gateway Integration**: Runtime uses Gateway for tool access
4. **Custom SigV4 Auth**: Secure communication with Gateway using AWS SigV4 signing
5. **All CDK**: Pure CDK TypeScript infrastructure
6. **Comprehensive Tools**: 5 weather tools including current, forecast, and historical data
7. **Security Best Practices**: SSL enforcement, KMS encryption, comprehensive logging

## Support

For issues or questions:
1. Check CloudWatch logs
2. Review STRUCTURE.md for project organization
3. Verify all prerequisites are met
4. Ensure Slack app configuration is correct
