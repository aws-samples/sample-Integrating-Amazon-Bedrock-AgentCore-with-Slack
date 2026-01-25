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
- `deploy.sh`: Deploy all 3 CDK stacks
- `cleanup.sh`: Destroy all resources

## Prerequisites

1. **AWS CLI** configured with credentials
2. **Node.js** (v18+) and npm
3. **Slack App** created with:
   - Bot Token (starts with `xoxb-`)
   - Signing Secret
   - Bot Token Scopes: `app_mentions:read`, `chat:write`, `im:history`
   - Event Subscriptions: `app_mention`, `message.im`

**Note:** Docker is NOT required locally - CodeBuild handles the image build in AWS.

## Quick Start

### 1. Deploy

```bash
# Set Slack credentials
export SLACK_BOT_TOKEN="xoxb-your-token"
export SLACK_SIGNING_SECRET="your-signing-secret"

# Deploy all stacks
./deploy.sh
```

The script will:
- Install CDK dependencies
- Build TypeScript
- Bootstrap CDK (if needed)
- Deploy all 3 stacks in order
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

```bash
./cleanup.sh
```

This will:
- Destroy all 3 CDK stacks
- Clean up ECR images
- Remove CloudWatch log groups

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
├── DEPLOYMENT-GUIDE.md     # Detailed deployment guide
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
2. Review DEPLOYMENT-GUIDE.md for detailed instructions
3. Review STRUCTURE.md for project organization
4. Verify all prerequisites are met
5. Ensure Slack app configuration is correct
